import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAnswer, LlmError, setLlmClientForTests, streamAnswer } from '../src/services/llm.js';

const originalEnvironment = {
  model: process.env.LLM_MODEL,
  provider: process.env.LLM_PROVIDER,
  key: process.env.GEMINI_API_KEY
};

function configureEnvironment() {
  process.env.LLM_MODEL = 'fake-model';
  process.env.LLM_PROVIDER = 'gemini';
  delete process.env.GEMINI_API_KEY;
}

function restoreEnvironment() {
  if (originalEnvironment.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = originalEnvironment.model;
  if (originalEnvironment.provider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = originalEnvironment.provider;
  if (originalEnvironment.key === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalEnvironment.key;
  setLlmClientForTests(null);
}

test('generateAnswer retries a 503 then succeeds', async () => {
  configureEnvironment();
  let calls = 0;
  setLlmClientForTests({ models: { async generateContent() {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('temporary failure'), { status: 503 });
    return { text: 'The answer' };
  } } });
  try {
    assert.equal(await generateAnswer({ system: 'System', user: 'Question' }), 'The answer');
    assert.equal(calls, 2);
  } finally {
    restoreEnvironment();
  }
});

test('streamAnswer does not retry after any text was emitted', async () => {
  configureEnvironment();
  let calls = 0;
  setLlmClientForTests({ models: { async generateContentStream() {
    calls += 1;
    return (async function* stream() {
      yield { text: 'partial' };
      throw Object.assign(new Error('service failed'), { response: { status: 503 } });
    }());
  } } });
  const iterator = streamAnswer({ system: 'System', user: 'Question' });
  try {
    assert.deepEqual(await iterator.next(), { value: 'partial', done: false });
    await assert.rejects(iterator.next(), error => error instanceof LlmError && error.status === 503);
    assert.equal(calls, 1);
  } finally {
    restoreEnvironment();
  }
});

test('streamAnswer aborts during retry wait without another model call or error', async () => {
  configureEnvironment();
  let calls = 0;
  setLlmClientForTests({ models: { async generateContentStream() {
    calls += 1;
    return (async function* stream() {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    }());
  } } });
  const controller = new AbortController();
  const deltas = [];
  const consume = (async () => {
    for await (const delta of streamAnswer({ system: 'System', user: 'Question', signal: controller.signal })) {
      deltas.push(delta);
    }
  })();
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await consume;
    assert.equal(calls, 1);
    assert.deepEqual(deltas, []);
  } finally {
    restoreEnvironment();
  }
});

test('missing LLM_MODEL throws the required configuration error', async () => {
  configureEnvironment();
  delete process.env.LLM_MODEL;
  setLlmClientForTests({ models: { async generateContent() { assert.fail('model should not be called'); } } });
  try {
    await assert.rejects(generateAnswer({ system: 'System', user: 'Question' }), error =>
      error instanceof LlmError
      && error.status === 503
      && error.publicMessage === 'LLM_MODEL is required. Set it in server/.env.'
    );
  } finally {
    restoreEnvironment();
  }
});

test('numbers in error messages do not set an HTTP status or trigger retries', async () => {
  configureEnvironment();
  let calls = 0;
  setLlmClientForTests({ models: { async generateContent() {
    calls += 1;
    throw new Error('the model mentioned 503 in its message');
  } } });
  try {
    await assert.rejects(generateAnswer({ system: 'System', user: 'Question' }), error => error instanceof LlmError && error.status === 502);
    assert.equal(calls, 1);
  } finally {
    restoreEnvironment();
  }
});
