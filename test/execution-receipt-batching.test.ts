import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { TransactionReceiptNotFoundError } from 'viem';
import { publicClient } from '../src/cli/environment.ts';
import { stableReceipt } from '../src/execution/outcome.ts';
import type { ApplyContext } from '../src/execution/context.ts';
import type { Hash } from '../src/types.ts';

const hash = (digit: string) => `0x${digit.repeat(64)}` as Hash;
const transactionHash = hash('1');
const receipt = { transactionHash, blockNumber: 1n, blockHash: hash('a'), status: 'success' };
const actionId = 'call:alpha';
function context() {
  return {
    config: { receiptTimeoutMs: 20, pollIntervalMs: 1 },
    validatedReceipts: new Map(),
    client: {
      async getTransactionReceipt() {
        return receipt;
      },
      async getBlock() {
        return { number: 1n, hash: receipt.blockHash };
      },
    },
  } as unknown as ApplyContext;
}

test('validated inclusion survives receipt indexing loss but cannot survive restart or reorg', async () => {
  const ctx = context();
  await stableReceipt(ctx, transactionHash, receipt, actionId);
  const missing = async () => {
    throw new TransactionReceiptNotFoundError({ hash: transactionHash });
  };
  ctx.client.getTransactionReceipt = missing;
  assert.equal(await stableReceipt(ctx, transactionHash, receipt, actionId), receipt);
  const restored = context();
  restored.client.getTransactionReceipt = missing;
  await assert.rejects(stableReceipt(restored, transactionHash, receipt, actionId), {
    code: 'receipt-timeout',
  });
  ctx.client.getBlock = async () => ({ number: 1n, hash: hash('b') });
  await assert.rejects(stableReceipt(ctx, transactionHash, receipt, actionId), { code: 'reorg' });
});

test('gas estimates in one batch keep their own results and errors', async () => {
  const senders = ['1', '2', '3'].map((digit) => `0x${digit.repeat(40)}`);
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    // The estimate of the second sender fails, and a batch answers in reverse order.
    const answer = (rpc) => {
      const sender = senders.indexOf(rpc.params[0].from);
      return sender === 1
        ? { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'estimate unavailable' } }
        : { jsonrpc: '2.0', id: rpc.id, result: `0x${(21_000 + sender).toString(16)}` };
    };
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(Array.isArray(parsed) ? parsed.toReversed().map(answer) : answer(parsed)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = publicClient(`http://127.0.0.1:${server.address().port}`);
    const results = await Promise.allSettled(
      senders.map((account) => client.estimateGas({ account, to: senders[0], data: '0x' })),
    );
    assert.deepEqual(
      results.map((result) => (result.status === 'fulfilled' ? result.value : result.status)),
      [21_000n, 'rejected', 21_002n],
    );
    assert.match(results[1].reason.message, /estimate unavailable/);
    assert.deepEqual(
      bodies.map((sent) => (Array.isArray(sent) ? sent.length : 1)),
      [3],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('RPC reads batch with response IDs preserved while broadcasts remain individual', async () => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    const answer = (rpc) => ({
      jsonrpc: '2.0',
      id: rpc.id,
      result: rpc.method === 'eth_sendRawTransaction' ? transactionHash : { number: rpc.params[0] },
    });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(Array.isArray(parsed) ? parsed.toReversed().map(answer) : answer(parsed)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = publicClient(`http://127.0.0.1:${server.address().port}`);
    const results = await Promise.all([
      client.request({ method: 'eth_getBlockByNumber', params: ['0x1', false] }),
      client.request({ method: 'eth_getBlockByNumber', params: ['0x2', false] }),
      client.request({ method: 'eth_sendRawTransaction', params: ['0x01'] }),
      client.request({ method: 'eth_sendRawTransaction', params: ['0x02'] }),
    ]);
    assert.deepEqual(
      results.slice(0, 2).map((block) => block.number),
      ['0x1', '0x2'],
    );
    assert.ok(bodies.some(Array.isArray));
    assert.ok(
      bodies
        .filter(Array.isArray)
        .every((batch) => batch.every((rpc) => rpc.method !== 'eth_sendRawTransaction')),
    );
    assert.equal(bodies.filter((body) => body.method === 'eth_sendRawTransaction').length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
