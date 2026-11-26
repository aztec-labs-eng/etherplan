import assert from 'node:assert/strict';
import test from 'node:test';
import { timed } from '../src/execution/report.ts';
import type { ApplyContext } from '../src/execution/context.ts';

function context(reporter) {
  return {
    plan: {
      planHash: `0x${'11'.repeat(32)}`,
      chain: { id: 1, genesisHash: `0x${'22'.repeat(32)}` },
    },
    scope: null,
    principal: undefined,
    config: { reporter },
    steps: [],
  } as unknown as ApplyContext;
}

test('a timed step reports its duration and never changes the result or the error of the step', async () => {
  const events = [];
  const ctx = context((event) => events.push(event));
  const value = { answer: 42 };
  assert.equal(await timed(ctx, 'funding', async () => value, 3), value);

  const failure = new Error('step failed');
  await assert.rejects(
    timed(ctx, 'signer-history', async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(
    ctx.steps.map(({ step, wave, failed }) => ({ step, wave, failed })),
    [
      { step: 'funding', wave: 3, failed: undefined },
      { step: 'signer-history', wave: undefined, failed: true },
    ],
  );
  assert.ok(
    ctx.steps.every((entry) => entry.ms >= 0 && !Number.isNaN(Date.parse(entry.startedAt))),
  );
  assert.deepEqual(
    events.map(({ type, step, wave, failed }) => ({ type, step, wave, failed })),
    [
      { type: 'step', step: 'funding', wave: 3, failed: undefined },
      { type: 'step', step: 'signer-history', wave: undefined, failed: true },
    ],
  );

  // A reporter that fails on the report of a failed step does not replace the error of the step.
  const silent = context(() => {
    throw new Error('reporter failed');
  });
  await assert.rejects(
    timed(silent, 'decide', async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});
