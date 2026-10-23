import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateAnswer,
  LlmError,
  setLlmClientForTests,
  streamAnswer
} from '../src/services/llm.js';

const envKeys = ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_FALLBACK_MODEL', 'GEMINI_API_KEY'];
let savedEnv;
let savedError;
let savedInfo;
let errors;
let infos;
let waits;

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.LLM_PROVIDER = 'gemini';
  process.env.LLM_MODEL = 'main-model';
  process.env.LLM_FALLBACK_MODEL = 'fallback-model';
  process.env.GEMINI_API_KEY = 'fake-key';
  errors = [];
  infos = [];
  waits = [];
  savedError = console.error;
  savedInfo = console.info;
  console.error = (...args) => errors.push(args.join(' '));
  console.info = (...args) => infos.push(args.join(' '));
});

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  console.error = savedError;
  console.info = savedInfo;
  setLlmClientForTests(undefined);
});

function quotaError(message = 'quota') {
  const error = new Error(message);
  error.status = 429;
  return error;
}

test('generateAnswer uses fallback once after primary retries fail with 429', async () => {
  const calls = [];
  setLlmClientForTests({ models: { generateContent: async request => {
    calls.push(request.model);
    if (request.model === 'main-model') throw quotaError();
    return { text: 'fallback answer' };
  } } }, { waitForRetry: async ms => { waits.push(ms); return true; } });

  assert.equal(await generateAnswer({ system: 'rules', user: 'question' }), 'fallback answer');
  assert.deepEqual(calls, ['main-model', 'fallback-model']);
  assert.deepEqual(waits, []);
  assert.ok(infos.some(line => line === 'fallback used: fallback-model'));
});

test('streamAnswer uses fallback after primary 429 retries and streams its answer', async () => {
  const calls = [];
  setLlmClientForTests({ models: {
    generateContentStream: async ({ model }) => {
      calls.push(model);
      if (model === 'main-model') throw quotaError();
      return (async function* () { yield { text: 'streamed fallback' }; }());
    }
  } }, { waitForRetry: async ms => { waits.push(ms); return true; } });

  const deltas = [];
  for await (const delta of streamAnswer({ system: 'rules', user: 'question' })) deltas.push(delta);
  assert.deepEqual(deltas, ['streamed fallback']);
  assert.deepEqual(calls, ['main-model', 'fallback-model']);
});

test('streamAnswer does not retry or fall back after emitting text', async () => {
  let calls = 0;
  setLlmClientForTests({ models: { generateContentStream: async () => {
    calls += 1;
    return (async function* () {
      yield { text: 'partial' };
      throw quotaError();
    }());
  } } }, { waitForRetry: async ms => { waits.push(ms); return true; } });

  const deltas = [];
  await assert.rejects(async () => {
    for await (const delta of streamAnswer({ system: 'rules', user: 'question' })) deltas.push(delta);
  }, error => error instanceof LlmError && error.status === 429);
  assert.deepEqual(deltas, ['partial']);
  assert.equal(calls, 1);
});

test('fallback is not called when LLM_FALLBACK_MODEL is unset', async () => {
  delete process.env.LLM_FALLBACK_MODEL;
  const calls = [];
  setLlmClientForTests({ models: { generateContent: async ({ model }) => {
    calls.push(model);
    throw quotaError();
  } } }, { waitForRetry: async ms => { waits.push(ms); return true; } });

  await assert.rejects(generateAnswer({ system: 'rules', user: 'question' }), error => (
    error instanceof LlmError && error.status === 429 &&
    error.publicMessage === 'The free model quota is used up for now. Cached questions still work.'
  ));
  assert.deepEqual(calls, ['main-model']);
  assert.deepEqual(waits, []);
});

test('model failure log redacts API keys and does not log prompts', async () => {
  const key = 'AIzaSyDUMMY_123-abc';
  setLlmClientForTests({ models: { generateContent: async () => {
    const error = new Error(`bad key ${key}`);
    error.status = 400;
    error.details = [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'PerMinuteQuota', quotaMetric: 'requests_per_minute' }] }];
    throw error;
  } } });

  await assert.rejects(generateAnswer({ system: 'private system prompt', user: 'private user prompt' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /model=main-model status=400 name=Error/);
  assert.match(errors[0], /\[redacted\]/);
  assert.match(errors[0], /quotaId=PerMinuteQuota/);
  assert.match(errors[0], /quotaMetric=requests_per_minute/);
  assert.doesNotMatch(errors[0], /AIza|private system prompt|private user prompt/);
});

test('LLM_MODEL remains required', async () => {
  delete process.env.LLM_MODEL;
  await assert.rejects(generateAnswer({ system: 'rules', user: 'question' }), error => (
    error instanceof LlmError && error.publicMessage === 'LLM_MODEL is required. Set it in server/.env.'
  ));
});

test('generateAnswer retries a 503 then succeeds without using fallback', async () => {
  delete process.env.LLM_FALLBACK_MODEL;
  const calls = [];
  setLlmClientForTests({ models: { generateContent: async ({ model }) => {
    calls.push(model);
    if (calls.length === 1) throw Object.assign(new Error('temporary failure'), { status: 503 });
    return { text: 'primary answer' };
  } } }, { overloadWaitMs: 1 });

  assert.equal(await generateAnswer({ system: 'rules', user: 'question' }), 'primary answer');
  assert.deepEqual(calls, ['main-model', 'main-model']);
});

test('streamAnswer aborts during retry wait without making another model call', async () => {
  let calls = 0;
  setLlmClientForTests({ models: { generateContentStream: async () => {
    calls += 1;
    return {
      [Symbol.asyncIterator]() {
        return { next: async () => { throw Object.assign(new Error('busy'), { status: 503 }); } };
      }
    };
  } } }, { overloadWaitMs: 500 });
  const controller = new AbortController();
  const answer = (async () => {
    const deltas = [];
    for await (const delta of streamAnswer({ system: 'rules', user: 'question', signal: controller.signal })) deltas.push(delta);
    return deltas;
  })();

  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  assert.deepEqual(await answer, []);
  assert.equal(calls, 1);
});

test('503 retries the primary once after two seconds, then uses fallback', async () => {
  const calls = [];
  setLlmClientForTests({ models: { generateContent: async ({ model }) => {
    calls.push(model);
    if (model === 'fallback-model') return { text: 'fallback answer' };
    throw Object.assign(new Error('service unavailable'), { status: 503 });
  } } }, { waitForRetry: async ms => { waits.push(ms); return true; } });

  assert.equal(await generateAnswer({ system: 'rules', user: 'question' }), 'fallback answer');
  assert.deepEqual(calls, ['main-model', 'main-model', 'fallback-model']);
  assert.deepEqual(waits, [2000]);
});

test('PerDay 429 is not retried before fallback', async () => {
  const calls = [];
  setLlmClientForTests({ models: { generateContent: async ({ model }) => {
    calls.push(model);
    if (model === 'fallback-model') return { text: 'fallback answer' };
    throw Object.assign(new Error('quota exhausted'), {
      status: 429,
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProject' }] }]
    });
  } } }, { waitForRetry: async ms => { waits.push(ms); return true; } });

  assert.equal(await generateAnswer({ system: 'rules', user: 'question' }), 'fallback answer');
  assert.deepEqual(calls, ['main-model', 'fallback-model']);
  assert.deepEqual(waits, []);
});

test('PerDay 429 without fallback returns the cached-questions quota message', async () => {
  delete process.env.LLM_FALLBACK_MODEL;
  let calls = 0;
  setLlmClientForTests({ models: { generateContent: async () => {
    calls += 1;
    throw Object.assign(new Error('daily limit'), {
      status: 429,
      response: { data: { error: { details: [{ violations: [{ quotaMetric: 'requests_per_day' }] }] } } }
    });
  } } }, { waitForRetry: async ms => { waits.push(ms); return true; } });

  await assert.rejects(generateAnswer({ system: 'rules', user: 'question' }), error => (
    error instanceof LlmError && error.publicMessage === 'The free model quota is used up for now. Cached questions still work.'
  ));
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('PerMinute 429 waits once, then retries the primary', async () => {
  let calls = 0;
  setLlmClientForTests({ models: { generateContent: async ({ model }) => {
    assert.equal(model, 'main-model');
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('rate limit'), {
      status: 429,
      details: [{ violations: [{ quotaMetric: 'PerMinuteRequests' }] }]
    });
    return { text: 'answer after waiting' };
  } } }, { waitForRetry: async (ms, signal) => { waits.push(ms); return !signal.aborted; } });

  assert.equal(await generateAnswer({ system: 'rules', user: 'question' }), 'answer after waiting');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [20_000]);
});

test('fallback failure gives the cached-questions quota message', async () => {
  setLlmClientForTests({ models: { generateContent: async ({ model }) => {
    const error = new Error('quota exhausted');
    error.status = 429;
    error.details = [{ violations: [{ quotaId: 'PerDay' }] }];
    if (model === 'fallback-model') error.message = 'fallback is busy';
    throw error;
  } } }, { waitForRetry: async () => true });

  await assert.rejects(generateAnswer({ system: 'rules', user: 'question' }), error => (
    error instanceof LlmError && error.publicMessage === 'The free model quota is used up for now. Cached questions still work.'
  ));
});

test('numbers in an error message do not set a status or trigger retries', async () => {
  delete process.env.LLM_FALLBACK_MODEL;
  let calls = 0;
  setLlmClientForTests({ models: { generateContent: async () => {
    calls += 1;
    throw new Error('the model mentioned 503 in its message');
  } } });

  await assert.rejects(generateAnswer({ system: 'rules', user: 'question' }), error => (
    error instanceof LlmError && error.status === 502
  ));
  assert.equal(calls, 1);
});
