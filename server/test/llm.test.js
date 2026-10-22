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

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.LLM_PROVIDER = 'gemini';
  process.env.LLM_MODEL = 'main-model';
  process.env.LLM_FALLBACK_MODEL = 'fallback-model';
  process.env.GEMINI_API_KEY = 'fake-key';
  errors = [];
  infos = [];
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
  } } }, { retryBaseMs: 1 });

  assert.equal(await generateAnswer({ system: 'rules', user: 'question' }), 'fallback answer');
  assert.deepEqual(calls, ['main-model', 'main-model', 'main-model', 'fallback-model']);
  assert.ok(infos.some(line => line.includes('fallback answered model=fallback-model')));
});

test('streamAnswer uses fallback after primary 429 retries and streams its answer', async () => {
  const calls = [];
  setLlmClientForTests({ models: {
    generateContentStream: async ({ model }) => {
      calls.push(model);
      if (model === 'main-model') throw quotaError();
      return (async function* () { yield { text: 'streamed fallback' }; }());
    }
  } }, { retryBaseMs: 1 });

  const deltas = [];
  for await (const delta of streamAnswer({ system: 'rules', user: 'question' })) deltas.push(delta);
  assert.deepEqual(deltas, ['streamed fallback']);
  assert.deepEqual(calls, ['main-model', 'main-model', 'main-model', 'fallback-model']);
});

test('streamAnswer does not retry or fall back after emitting text', async () => {
  let calls = 0;
  setLlmClientForTests({ models: { generateContentStream: async () => {
    calls += 1;
    return (async function* () {
      yield { text: 'partial' };
      throw quotaError();
    }());
  } } }, { retryBaseMs: 1 });

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
  } } }, { retryBaseMs: 1 });

  await assert.rejects(generateAnswer({ system: 'rules', user: 'question' }), error => (
    error instanceof LlmError && error.status === 429 &&
    error.publicMessage === 'The free model quota is used up for now. Try again later.'
  ));
  assert.deepEqual(calls, ['main-model', 'main-model', 'main-model']);
});

test('model failure log redacts API keys and does not log prompts', async () => {
  const key = 'AIzaSyDUMMY_123-abc';
  setLlmClientForTests({ models: { generateContent: async () => {
    const error = new Error(`bad key ${key}`);
    error.status = 400;
    throw error;
  } } });

  await assert.rejects(generateAnswer({ system: 'private system prompt', user: 'private user prompt' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /model=main-model status=400 name=Error/);
  assert.match(errors[0], /\[redacted\]/);
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
  } } }, { retryBaseMs: 1 });

  assert.equal(await generateAnswer({ system: 'rules', user: 'question' }), 'primary answer');
  assert.deepEqual(calls, ['main-model', 'main-model']);
});

test('streamAnswer aborts during retry wait without making another model call', async () => {
  let calls = 0;
  setLlmClientForTests({ models: { generateContentStream: async () => {
    calls += 1;
    return {
      [Symbol.asyncIterator]() {
        return { next: async () => { throw quotaError(); } };
      }
    };
  } } }, { retryBaseMs: 500 });
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
