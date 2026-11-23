import assert from 'node:assert/strict';
import test from 'node:test';
import { InternalRpcError } from 'viem';
import { assertSignerHistory } from '../src/execution/settlement.ts';
import { hashJson } from '../src/identity.ts';
import { deployerA, deployerB } from './execution/chain.ts';
import type { ApplyContext, SignedIndexEntry } from '../src/execution/types.ts';
import type { Hash } from '../src/types.ts';

const hash = (digit: string) => `0x${digit.repeat(64)}` as Hash;
const original = hash('1');
const replacement = hash('2');
const otherAction = hash('3');
const blockHash = hash('a');
const priorPlan = hash('b');
const currentPlan = hash('c');
const signer = deployerA.address.toLowerCase();

function indexEntry(transactionHash: Hash, actionId = 'contract:alpha'): SignedIndexEntry {
  return {
    project: 'test',
    environment: 'dev',
    label: 'previous',
    planHash: priorPlan,
    actionId,
    signer,
    nonce: '7',
    transactionHash,
  };
}

function history(
  rows: SignedIndexEntry[],
  mined: Hash[],
  confirmations = 1,
  latestBlock = 12n,
  linked = true,
) {
  const scope = {
    project: 'test',
    environment: 'dev',
    chainId: 31337,
    genesisHash: hash('d'),
    label: 'next',
  };
  const indexed: { label: string; address: string }[] = [];
  const journalReads: string[] = [];
  const receiptLookups: string[] = [];
  const nonceReads: bigint[] = [];
  const receipts = new Set(mined);
  const ordered = [original, replacement, otherAction].flatMap((transactionHash) =>
    rows.filter((row) => row.transactionHash === transactionHash),
  );
  const journal = ordered.reduce(
    (records, row, index) => {
      const fields = {
        formatVersion: 2,
        sequence: index + 1,
        previousHash: records.at(-1)?.recordHash ?? null,
        planHash: row.planHash,
        chain: { id: scope.chainId, genesisHash: scope.genesisHash },
        actionId: row.actionId,
        phase: 'signed',
        signer: row.signer,
        nonce: row.nonce,
        transactionHash: row.transactionHash,
        ...(row.transactionHash === replacement && linked
          ? { replacement: true, replacesTransactionHash: original }
          : {}),
        encryptedRawTransaction: { ciphertext: 'test' },
        principal: 'test-runner',
        at: new Date().toISOString(),
      };
      records.push({ ...fields, recordHash: hashJson(fields) });
      return records;
    },
    [] as { recordHash: Hash }[],
  );
  const ctx = {
    remote: true,
    scope,
    plan: { planHash: currentPlan },
    config: { confirmations, receiptTimeoutMs: 20 },
    journal: { records: journal.map((record) => ({ ...record, rawTransaction: '0x01' })) },
    journalStore: {
      async *signedForSigner(requestedScope: typeof scope, address: string) {
        indexed.push({ label: requestedScope.label, address });
        for (const row of rows) yield row;
      },
      async *read(requestedScope: typeof scope) {
        journalReads.push(requestedScope);
        for (const record of journal) yield record;
      },
    },
    client: {
      async getTransactionReceipt({ hash: transactionHash }: { hash: Hash }) {
        receiptLookups.push(transactionHash);
        if (!receipts.has(transactionHash))
          throw Object.assign(new Error('no receipt'), { name: 'TransactionReceiptNotFoundError' });
        return { transactionHash, blockNumber: 12n, blockHash };
      },
      async getBlock({ blockNumber }: { blockNumber?: bigint }) {
        return blockNumber === undefined
          ? { number: latestBlock, hash: blockHash }
          : { number: blockNumber, hash: blockHash };
      },
      // Each mined transaction is in block 12 at nonce 7, so the account nonce is 8 from that block.
      async getTransactionCount({
        address,
        blockNumber,
      }: {
        address: string;
        blockNumber: bigint;
      }) {
        nonceReads.push(blockNumber);
        const used = rows.some(
          (row) => row.signer === address.toLowerCase() && receipts.has(row.transactionHash),
        );
        return used && blockNumber >= 12n ? 8 : 7;
      },
    },
  } as unknown as ApplyContext;
  return { ctx, indexed, journalReads, receiptLookups, nonceReads };
}

async function rejectsCode(ctx: ApplyContext, code: string, actionId = 'contract:alpha') {
  await assert.rejects(assertSignerHistory(ctx, [deployerA.address]), (error) => {
    assert.equal(error.code, code, error.message);
    assert.equal(error.actionId, actionId);
    return true;
  });
}

test('a mined replacement settles the original index row across deployment labels', async () => {
  const rows = [indexEntry(original), indexEntry(replacement)];
  const { ctx, indexed, journalReads, receiptLookups, nonceReads } = history(rows, [replacement]);
  await assertSignerHistory(ctx, [deployerA.address]);
  assert.deepEqual(indexed, [{ label: 'next', address: signer }]);
  assert.deepEqual(journalReads, [{ ...ctx.scope, label: 'previous' }]);
  // The chain used the nonce, so one account nonce read settles both rows and no receipt is read.
  assert.deepEqual(nonceReads, [12n]);
  assert.deepEqual(receiptLookups, []);
});

test('the original receipt also settles a signer nonce with a replacement index row', async () => {
  const rows = [indexEntry(replacement), indexEntry(original)];
  const { ctx } = history(rows, [original]);
  await assertSignerHistory(ctx, [deployerA.address]);
});

test('missing receipts and insufficient confirmations stop signer reuse', async () => {
  const rows = [indexEntry(original), indexEntry(replacement)];
  await rejectsCode(history(rows, []).ctx, 'foreign-outstanding');
  await rejectsCode(history(rows, [replacement], 2).ctx, 'finality');
  await assertSignerHistory(history(rows, [replacement], 2, 13n).ctx, [deployerA.address]);
});

test('a signature whose nonce another transaction used cannot be included, so it does not stop the signer', async () => {
  const rows = [
    indexEntry(original),
    indexEntry(replacement),
    indexEntry(otherAction, 'contract:beta'),
  ];
  await assertSignerHistory(history(rows, [replacement]).ctx, [deployerA.address]);
  // The same signature stops the signer while the chain has not used its nonce.
  await rejectsCode(history(rows, []).ctx, 'foreign-outstanding');
});

test('an unlinked signed transaction at the same action and nonce is not a replacement variant', async () => {
  const rows = [indexEntry(original), indexEntry(replacement)];
  await rejectsCode(history(rows, [replacement], 1, 12n, false).ctx, 'journal');
});

test('same label and plan hash in another project still reads its source journal', async () => {
  const row = {
    ...indexEntry(original),
    project: 'source',
    environment: 'prod',
    label: 'same',
    planHash: currentPlan,
  };
  const { ctx, journalReads } = history([row], []);
  ctx.scope = { ...ctx.scope!, project: 'current', environment: 'dev', label: 'same' };
  await rejectsCode(ctx, 'foreign-outstanding');
  assert.deepEqual(journalReads, [{ ...ctx.scope, project: 'source', environment: 'prod' }]);
});

test('a current-plan signature without a canonical receipt blocks a fresh nonce', async () => {
  const row = { ...indexEntry(original), label: 'next', planHash: currentPlan };
  await rejectsCode(history([row], []).ctx, 'foreign-outstanding');
  await assertSignerHistory(history([row], []).ctx, [deployerA.address], new Set([original]));
});

test('shared signer history remains usable after a transient receipt outage', async () => {
  const { ctx } = history([indexEntry(original)], [original]);
  ctx.config.pollIntervalMs = 1;
  ctx.config.receiptTimeoutMs = 1_000;
  const lookup = ctx.client.getTransactionCount;
  let failed = false;
  ctx.client.getTransactionCount = async (request) => {
    if (!failed) {
      failed = true;
      throw new InternalRpcError(new Error('temporarily unavailable'));
    }
    return lookup(request);
  };
  await assertSignerHistory(ctx, [deployerA.address]);
  assert.equal(failed, true);
});

test('the open current journal survives reread outages and includes later signatures', async () => {
  const rows = [{ ...indexEntry(original), label: 'next', planHash: currentPlan }];
  const { ctx } = history(rows, [original]);
  ctx.journalStore!.read = async function* () {
    throw new Error('journal reread unavailable');
  };
  ctx.journalStore!.head = async () => {
    throw new Error('journal head reread unavailable');
  };
  await assertSignerHistory(ctx, [deployerA.address]);
  ctx.journalStore!.signedForSigner = async function* () {
    throw new Error('signer index unavailable');
  };
  const next = { ...rows[0], transactionHash: otherAction, actionId: 'contract:beta', nonce: '8' };
  rows.push(next);
  ctx.journal.records.push({ ...ctx.journal.records[0], ...next, sequence: 2 });
  await rejectsCode(ctx, 'foreign-outstanding', 'contract:beta');
});

for (const field of ['project', 'environment', 'label']) {
  test(`another ${field} still requires a valid source journal`, async () => {
    const row = { ...indexEntry(original), label: 'next', planHash: currentPlan, [field]: 'other' };
    const { ctx } = history([row], [original]);
    const read = ctx.journalStore!.read;
    ctx.journalStore!.read = async function* (scope) {
      for await (const record of read(scope)) yield { ...record, recordHash: hash('e') };
    };
    await assert.rejects(
      assertSignerHistory(ctx, [deployerA.address]),
      /Journal integrity failure/,
    );
  });
}

test('validated signer history survives reread outages but still detects reorganizations and reloads on restart', async () => {
  const rows = [indexEntry(original)];
  const { ctx } = history(rows, [original]);
  await assertSignerHistory(ctx, [deployerA.address]);
  const unavailable = async function* () {
    throw new Error('history reread unavailable');
  };
  ctx.journalStore!.signedForSigner = unavailable;
  ctx.journalStore!.read = unavailable;
  ctx.journalStore!.head = async () => {
    throw new Error('head reread unavailable');
  };
  await assertSignerHistory(ctx, [deployerA.address]);
  // A reorganization removes the transaction from the chain: its block changes and its nonce is free again.
  ctx.client.getBlock = async () => ({ number: 12n, hash: hash('e') });
  ctx.client.getTransactionCount = async () => 7;
  await rejectsCode(ctx, 'reorg');
  await rejectsCode(history(rows, []).ctx, 'foreign-outstanding');
});

test('a replacement appended after the history snapshot can settle its original signature', async () => {
  const { ctx } = history(
    [{ ...indexEntry(original), label: 'next', planHash: currentPlan }],
    [replacement],
  );
  await assertSignerHistory(ctx, [deployerA.address], new Set([original]));
  ctx.journalStore!.signedForSigner = async function* () {
    throw new Error('index unavailable');
  };
  ctx.journal.records.push({
    ...ctx.journal.records[0],
    sequence: 2,
    transactionHash: replacement,
    replacement: true,
    replacesTransactionHash: original,
  });
  await assertSignerHistory(ctx, [deployerA.address]);
});

test('a snapshot for one signer cannot hide another signer outstanding transaction', async () => {
  const rows = [
    indexEntry(original),
    { ...indexEntry(otherAction, 'contract:beta'), signer: deployerB.address.toLowerCase() },
  ];
  const { ctx } = history(rows, [original]);
  ctx.journalStore!.signedForSigner = async function* (_scope, address) {
    for (const row of rows) if (row.signer === address) yield row;
  };
  await assertSignerHistory(ctx, [deployerA.address]);
  await assert.rejects(assertSignerHistory(ctx, [deployerB.address]), (error) => {
    assert.equal(error.code, 'foreign-outstanding', error.message);
    assert.equal(error.actionId, 'contract:beta');
    return true;
  });
});

test('an interrupted index read cannot publish a partial history snapshot', async () => {
  const rows = [indexEntry(original), { ...indexEntry(otherAction, 'contract:beta'), nonce: '8' }];
  const { ctx } = history(rows, [original]);
  let interrupted = false;
  ctx.journalStore!.signedForSigner = async function* () {
    yield rows[0]!;
    if (!interrupted) {
      interrupted = true;
      throw new Error('index interrupted');
    }
    yield rows[1]!;
  };
  await assert.rejects(assertSignerHistory(ctx, [deployerA.address]), /index interrupted/);
  await rejectsCode(ctx, 'foreign-outstanding', 'contract:beta');
});
