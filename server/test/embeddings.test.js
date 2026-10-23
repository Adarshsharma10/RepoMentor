import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenPacer } from '../src/services/embeddings.js';

test('token pacing waits for rolling-minute capacity using an injected clock', async () => {
  let time = 0;
  const sleeps = [];
  const pacer = createTokenPacer({
    limit: 25000,
    windowMs: 60000,
    now: () => time,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      time += milliseconds;
    }
  });

  await pacer.waitForTokens(20000);
  assert.equal(time, 0);
  await pacer.waitForTokens(10000);
  assert.equal(time, 60000);
  assert.deepEqual(sleeps, [60000]);
  await pacer.waitForTokens(15000);
  assert.equal(time, 60000);
});
