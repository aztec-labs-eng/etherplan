import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InternalRpcError, TransactionReceiptNotFoundError } from 'viem';
import { applyPlan } from '../src/execution/index.ts';
import { readLocalJournal } from '../src/execution/journal.ts';
import { createPlan } from '../src/planning/index.ts';
import { deployerA, fixtureMany, startAnvil } from './execution/chain.ts';

// Each row fails one read once. 'settling' and 'unindexed' fail it after the broadcast;
// 'unindexed' also reports the receipt missing once, so settlement must read the nonce.
for (const [pipeline, phase, read = 'getTransactionReceipt'] of [
  [true, 'fresh'],
  [false, 'signed'],
  [true, 'signed'],
  [false, 'verified'],
  [false, 'history'],
  [true, 'polling'],
  [false, 'settling', 'getBlock'],
  [true, 'settling', 'getBlock'],
  [false, 'unindexed', 'getTransactionCount'],
  [true, 'unindexed', 'getTransactionCount'],
  [false, 'fresh', 'getTransactionCount'],
  [true, 'fresh', 'getTransactionCount'],
]) {
  test(`${pipeline ? 'pipeline' : 'serial'} ${phase} ${read} outage recovers without duplicate transactions`, async (t) => {
    const chain = await startAnvil();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-receipt-recovery-'));
    try {
      const { spec, artifacts } = fixtureMany(1);
      const policy = { deployers: [deployerA.address], parallel: false };
      const planning = {
        spec,
        artifacts,
        client: chain.client,
        ...(pipeline ? { pipeline: policy } : { signers: policy }),
        maxSpendWei: '100000000000000000000',
      };
      let input = {
        spec,
        artifacts,
        plan: await createPlan(planning),
        client: chain.client,
        signers: { deployer: [deployerA] },
        pipeline,
        pollIntervalMs: 1,
        receiptTimeoutMs: 5_000,
        stateFile: path.join(dir, 'state.json'),
        journalFile: path.join(dir, 'journal.jsonl'),
      };
      let historyHash;
      if (phase === 'history') {
        await applyPlan(input);
        historyHash = (await readLocalJournal(input.journalFile)).find(
          (r) => r.phase === 'signed',
        ).transactionHash;
        spec.contracts[0].salt = `0x${'f'.repeat(64)}`;
        input = {
          ...input,
          plan: await createPlan(planning),
          stateFile: path.join(dir, 'next-state.json'),
          journalFile: path.join(dir, 'next-journal.jsonl'),
        };
      } else if (phase === 'signed' || phase === 'verified') {
        const interruption = new Error('interrupted apply');
        await assert.rejects(
          applyPlan({
            ...input,
            hooks: {
              afterRecord(record) {
                if (record.phase === phase) throw interruption;
              },
            },
          }),
          (error) => error === interruption,
        );
      }
      let failed = false;
      let withheld = false;
      let broadcasted = false;
      let offset = 0;
      const now = Date.now.bind(Date);
      if (phase === 'polling') t.mock.method(Date, 'now', () => now() + offset);
      const outage = (method) => async (request) => {
        if (
          phase === 'unindexed' &&
          method === 'getTransactionReceipt' &&
          broadcasted &&
          !withheld
        ) {
          withheld = true;
          throw new TransactionReceiptNotFoundError({ hash: request.hash });
        }
        if (
          method === read &&
          !failed &&
          (!historyHash || request.hash === historyHash) &&
          (!['polling', 'settling', 'unindexed'].includes(phase) || broadcasted)
        ) {
          failed = true;
          if (phase === 'polling') offset += 1_100;
          throw new InternalRpcError(new Error('temporarily unavailable'));
        }
        return chain.client[method](request);
      };
      const client = Object.assign(Object.create(chain.client), {
        getTransactionReceipt: outage('getTransactionReceipt'),
        getBlock: outage('getBlock'),
        getTransactionCount: outage('getTransactionCount'),
      });
      const result = await applyPlan({
        ...input,
        client,
        hooks: {
          afterRecord(record) {
            broadcasted ||= record.phase === 'broadcast';
          },
        },
      });
      assert.equal(failed, true);
      assert.equal(result.status, 'applied');
      assert.equal(
        (await readLocalJournal(input.journalFile)).filter((r) => r.phase === 'signed').length,
        1,
      );
      assert.equal(
        await chain.client.getTransactionCount({ address: deployerA.address }),
        phase === 'history' ? 2 : 1,
      );
    } finally {
      await chain.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
