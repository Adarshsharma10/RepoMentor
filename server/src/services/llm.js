import { GoogleGenAI } from '@google/genai';

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const OVERALL_TIMEOUT_MS = 60_000;
let client;
let retryBaseMs = RETRY_BASE_MS;

export class LlmError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.name = 'LlmError';
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function errorStatus(error) {
  return [error?.status, error?.response?.status, error?.code]
    .find(value => Number.isInteger(value)) || 0;
}

function classifyError(error) {
  const status = errorStatus(error);
  return { status, retryable: status === 429 || (status >= 500 && status < 600) };
}

function safeLlmError(error) {
  const { status } = classifyError(error);
  if (status === 429) return new LlmError(429, 'The free model quota is used up for now. Try again later.');
  if (status === 503 || /overload/i.test(String(error?.message || '')))
    return new LlmError(503, 'The model is busy. Try again in a minute.');
  if (status >= 500 && status < 600) return new LlmError(503, 'The answer service is temporarily unavailable. Try again later.');
  if (status === 400) return new LlmError(400, 'The answer service could not process this request.');
  if (status === 401 || status === 403) return new LlmError(503, 'The Gemini API configuration is invalid. Check GEMINI_API_KEY.');
  return new LlmError(502, 'Could not generate an answer. Check the Gemini configuration and try again.');
}

function originalHttpStatus(error) {
  const status = error?.status ?? error?.response?.status;
  return Number.isInteger(status) ? status : 'unknown';
}

function logModelFailure(model, error) {
  const name = String(error?.name || 'Error').replace(/[\r\n]/g, ' ');
  const message = String(error?.message || '').slice(0, 200)
    .replace(/AIza[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\r\n]/g, ' ');
  console.error(`[llm] model=${model} status=${originalHttpStatus(error)} name=${name} message=${message}`);
}

class FallbackEligibleError extends Error {
  constructor(originalError) {
    super('Primary model failed after retries');
    this.name = 'FallbackEligibleError';
    this.originalError = originalError;
  }
}

function getModel() {
  const model = process.env.LLM_MODEL?.trim();
  if (!model) throw new LlmError(503, 'LLM_MODEL is required. Set it in server/.env.');
  return model;
}

function getClient() {
  const provider = (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();
  if (provider !== 'gemini') {
    throw new LlmError(503, `LLM_PROVIDER "${provider}" is not supported. Set it to "gemini".`);
  }
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new LlmError(503, 'GEMINI_API_KEY is required to answer questions. Add it to server/.env.');
  client = new GoogleGenAI({ apiKey });
  return client;
}

function makeOperationSignal(callerSignal) {
  const timeoutSignal = AbortSignal.timeout(OVERALL_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  return { signal, callerSignal, timeoutSignal };
}

function timeoutError() {
  return new LlmError(504, 'The answer service took too long. Try again.');
}

function isTimeout(signal, timeoutSignal) {
  return timeoutSignal.aborted && signal.reason === timeoutSignal.reason;
}

function abortError(signal) {
  return signal.reason || new DOMException('The operation was aborted.', 'AbortError');
}

function raceWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

function waitWithAbort(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Both one-shot and streaming calls use this retry and safe-error policy.
async function retryOperation(operation, { signal, callerSignal, timeoutSignal }, model) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (callerSignal?.aborted) return { aborted: true };
    if (timeoutSignal.aborted) throw timeoutError();
    if (signal.aborted) return { aborted: true };

    let emittedOutput = false;
    try {
      const value = await raceWithSignal(
        Promise.resolve().then(() => operation(signal, () => { emittedOutput = true; })),
        signal
      );
      return { value, aborted: false };
    } catch (error) {
      if (timeoutSignal.aborted) throw timeoutError();
      if (callerSignal?.aborted || (signal.aborted && !isTimeout(signal, timeoutSignal))) {
        return { aborted: true };
      }
      if (error instanceof LlmError) throw error;

      const { retryable } = classifyError(error);
      logModelFailure(model, error);
      if (retryable && !emittedOutput && attempt < MAX_RETRIES) {
        const waited = await waitWithAbort(retryBaseMs * (2 ** attempt), signal);
        if (!waited) {
          if (timeoutSignal.aborted) throw timeoutError();
          return { aborted: true };
        }
        continue;
      }
      if (retryable && !emittedOutput) throw new FallbackEligibleError(error);
      throw safeLlmError(error);
    }
  }
  throw new LlmError(503, 'The answer service failed after several attempts. Try again later.');
}

function getFallbackModel(primaryModel) {
  const fallback = process.env.LLM_FALLBACK_MODEL?.trim();
  return fallback && fallback !== primaryModel ? fallback : undefined;
}

async function runFallback(operation, model, { signal, callerSignal, timeoutSignal }) {
  if (callerSignal?.aborted || signal.aborted) return { aborted: true };
  if (timeoutSignal.aborted) throw timeoutError();
  try {
    const value = await raceWithSignal(Promise.resolve().then(() => operation(signal, () => {})), signal);
    return { value, aborted: false };
  } catch (error) {
    if (timeoutSignal.aborted) throw timeoutError();
    if (callerSignal?.aborted || (signal.aborted && !isTimeout(signal, timeoutSignal))) return { aborted: true };
    if (error instanceof LlmError) throw error;
    logModelFailure(model, error);
    throw safeLlmError(error);
  }
}

async function generateWithFallback(operation, primaryModel, signals) {
  try {
    return await retryOperation(operation(primaryModel), signals, primaryModel);
  } catch (error) {
    const fallbackModel = getFallbackModel(primaryModel);
    if (!(error instanceof FallbackEligibleError) || !fallbackModel) {
      if (error instanceof FallbackEligibleError) throw safeLlmError(error.originalError);
      throw error;
    }
    const result = await runFallback(operation(fallbackModel), fallbackModel, signals);
    if (!result.aborted) console.info(`[llm] fallback answered model=${fallbackModel}`);
    return result;
  }
}

function assertInput(system, user, operationName) {
  if (typeof system !== 'string' || typeof user !== 'string') {
    throw new TypeError(`${operationName} expects system and user strings`);
  }
}

export async function generateAnswer({ system, user, signal: callerSignal }) {
  assertInput(system, user, 'generateAnswer');
  const model = getModel();
  const genai = getClient();
  const operationSignal = makeOperationSignal(callerSignal);
  const result = await generateWithFallback(currentModel => signal => {
    return genai.models.generateContent({
      model: currentModel,
      contents: user,
      config: { systemInstruction: system, temperature: 0.2, maxOutputTokens: 1024, abortSignal: signal }
    }).then(response => {
      const answer = response.text?.trim();
      if (!answer) throw new LlmError(502, 'The answer service returned an empty answer. Try again.');
      return answer;
    });
  }, model, operationSignal);
  if (result.aborted) throw new LlmError(503, 'The answer request was cancelled.');
  return result.value;
}

function createTextQueue() {
  const values = [];
  const waiters = [];
  let ended = false;
  let failure;
  return {
    push(value) {
      if (ended) return;
      if (waiters.length) waiters.shift()({ value, done: false });
      else values.push(value);
    },
    close() {
      ended = true;
      while (waiters.length) waiters.shift()({ done: true });
    },
    fail(error) {
      failure = error;
      ended = true;
      while (waiters.length) waiters.shift()(Promise.reject(error));
    },
    async next() {
      if (values.length) return { value: values.shift(), done: false };
      if (failure) throw failure;
      if (ended) return { done: true };
      return new Promise(resolve => waiters.push(resolve));
    },
    [Symbol.asyncIterator]() { return this; }
  };
}

export async function* streamAnswer({ system, user, signal: callerSignal }) {
  assertInput(system, user, 'streamAnswer');
  if (callerSignal?.aborted) return;
  const model = getModel();
  const genai = getClient();
  const operationSignal = makeOperationSignal(callerSignal);
  const queue = createTextQueue();

  const streamOperation = currentModel => async (signal, markOutput) => {
    const responseStream = await genai.models.generateContentStream({
      model: currentModel,
      contents: user,
      config: { systemInstruction: system, temperature: 0.2, maxOutputTokens: 1024, abortSignal: signal }
    });
    let emittedText = false;
    for await (const response of responseStream) {
      if (signal.aborted) return;
      const delta = typeof response.text === 'string' ? response.text : '';
      if (!delta) continue;
      emittedText = true;
      markOutput();
      queue.push(delta);
    }
    if (!emittedText) throw new LlmError(502, 'The answer service returned an empty answer. Try again.');
  };
  const task = generateWithFallback(streamOperation, model, operationSignal)
    .then(() => queue.close())
    .catch(error => queue.fail(error));

  for await (const delta of queue) yield delta;
  await task;
}

export function setLlmClientForTests(fakeClient, options = {}) {
  client = fakeClient;
  retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
}
