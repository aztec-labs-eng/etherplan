import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HttpRequestError,
  InternalRpcError,
  InvalidParamsRpcError,
  TransactionReceiptNotFoundError,
} from 'viem';
import { findKnownReceipt, findReceipt } from '../src/execution/transactions.ts';

const original = `0x${'1'.repeat(64)}`;
const replacement = `0x${'2'.repeat(64)}`;
const variants = [original, replacement].map((transactionHash) => ({ transactionHash }));
const receipt = { transactionHash: replacement, status: 'success' };
const unavailable = new HttpRequestError({ status: 503, url: 'https://rpc.invalid' });
const missing = new TransactionReceiptNotFoundError({ hash: original });

test('receipt discovery recovers a mined replacement after provider failures', async () => {
  const outcomes = new Map([
    [original, [new Error('Request failed', { cause: unavailable }), missing]],
    [replacement, [new InternalRpcError(new Error('temporarily unavailable')), receipt]],
  ]);
  const client = {
    async getTransactionReceipt({ hash }) {
      const outcome = outcomes.get(hash).shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  assert.equal(
    await findKnownReceipt(client, variants, { deadline: Date.now() + 1_000, pollIntervalMs: 1 }),
    receipt,
  );
});

test('receipt discovery shares its deadline and never treats an outage as an absent transaction', async (t) => {
  let now = 0;
  let originalFailed = false;
  let replacementFailed = false;
  t.mock.method(Date, 'now', () => now);
  const client = {
    async getTransactionReceipt({ hash }) {
      if (hash === original) {
        now += 40;
        if (originalFailed) throw missing;
        originalFailed = true;
        throw unavailable;
      }
      if (!replacementFailed) {
        replacementFailed = true;
        now += 40;
        throw unavailable;
      }
      return receipt;
    },
  };
  await assert.rejects(
    findKnownReceipt(client, variants, { deadline: 100, pollIntervalMs: 1 }),
    (error) => error === unavailable,
  );
  assert.equal(replacementFailed, true);
});

test('permanent receipt failures propagate instead of being retried into a successful read', async () => {
  for (const cause of [
    new HttpRequestError({ status: 401, url: 'https://rpc.invalid' }),
    new InvalidParamsRpcError(new Error('invalid transaction hash')),
    new TypeError('malformed receipt response'),
  ]) {
    const failure = new Error('Request failed', { cause });
    let failed = false;
    const client = {
      async getTransactionReceipt() {
        if (!failed) {
          failed = true;
          throw failure;
        }
        return receipt;
      },
    };
    await assert.rejects(
      findReceipt(client, original, { deadline: Date.now() + 1_000, pollIntervalMs: 1 }),
      (error) => error === failure,
    );
  }
});
