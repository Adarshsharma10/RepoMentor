import { GoogleGenAI } from '@google/genai';

const OVERALL_TIMEOUT_MS = 60_000;
const DEFAULT_OVERLOAD_WAIT_MS = 2000;
const DEFAULT_PER_MINUTE_WAIT_MS = 20_000;
const GENERIC_RETRY_BASE_MS = 1000;
const QUOTA_MESSAGE = 'The free model quota is used up for now. Cached questions still work.';
let client;
let waitForRetry = waitWithAbort;
let overloadWaitMs = DEFAULT_OVERLOAD_WAIT_MS;
let perMinuteWaitMs = DEFAULT_PER_MINUTE_WAIT_MS;
let genericRetryBaseMs = GENERIC_RETRY_BASE_MS;

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

function collectQuotaDetails(error) {
  const quotaIds = new Set();
  const quotaMetrics = new Set();
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 7 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1));
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /quotaid/i.test(key)) quotaIds.add(item);
      if (typeof item === 'string' && /quotametric/i.test(key)) quotaMetrics.add(item);
      visit(item, depth + 1);
    }
  };
  visit(error?.details);
  visit(error?.errorDetails);
  visit(error?.error?.details);
  visit(error?.response?.data?.error?.details);
  visit(error?.response?.data?.details);
  visit(error?.response?.body?.error?.details);

  const message = String(error?.message || '');
  for (const match of message.matchAll(/quotaId["']?\s*[=:]\s*["']?([^\s,"'}]+)/gi)) quotaIds.add(match[1]);
  for (const match of message.matchAll(/quotaMetric["']?\s*[=:]\s*["']?([^\s,"'}]+)/gi)) quotaMetrics.add(match[1]);
  return { quotaIds: [...quotaIds], quotaMetrics: [...quotaMetrics] };
}

function quotaText(error) {
  const { quotaIds, quotaMetrics } = collectQuotaDetails(error);
  return [
    ...quotaIds,
    ...quotaMetrics,
    JSON.stringify(error?.details || ''),
    JSON.stringify(error?.errorDetails || ''),
    JSON.stringify(error?.error?.details || ''),
    JSON.stringify(error?.response?.data?.error?.details || ''),
    JSON.stringify(error?.response?.data?.details || ''),
    JSON.stringify(error?.response?.body?.error?.details || ''),
    String(error?.message || '')
  ].join(' ');
}

function classifyError(error) {
  const status = errorStatus(error);
  const text = quotaText(error);
  const normalizedQuotaText = text.replace(/[^a-z]/gi, '').toLowerCase();
  return {
    status,
    perDay: normalizedQuotaText.includes('perday'),
    perMinute: normalizedQuotaText.includes('perminute'),
    overloaded: status === 503 || /high demand|overloaded/i.test(text),
    retryable: status === 429 || (status >= 500 && status < 600) || /high demand|overloaded/i.test(text)
  };
}

function safeLlmError(error) {
  const { status, overloaded } = classifyError(error);
  if (status === 429) return new LlmError(429, QUOTA_MESSAGE);
  if (status === 503 || overloaded) return new LlmError(503, 'The model is busy. Try again in a minute.');
  if (status >= 500 && status < 600) return new LlmError(503, 'The answer service is temporarily unavailable. Try again later.');
  if (status === 400) return new LlmError(400, 'The answer service could not process this request.');
  if (status === 401 || status === 403) return new LlmError(503, 'The Gemini API configuration is invalid. Check GEMINI_API_KEY.');
  return new LlmError(502, 'Could not generate an answer. Check the Gemini configuration and try again.');
}

function originalHttpStatus(error) {
  const status = error?.status ?? error?.response?.status;
  return Number.isInteger(status) ? status : 'unknown';
}

function redactLogValue(value) {
  return String(value ?? '').slice(0, 300)
    .replace(/AIza[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\r\n\t]/g, ' ');
}

function logModelFailure(model, error) {
  const { quotaIds, quotaMetrics } = collectQuotaDetails(error);
  const quota = [
    ...quotaIds.map(value => `quotaId=${redactLogValue(value)}`),
    ...quotaMetrics.map(value => `quotaMetric=${redactLogValue(value)}`)
  ].join(' ');
  const name = redactLogValue(error?.name || 'Error');
  const message = redactLogValue(error?.message || '');
  console.error(`[llm] model=${redactLogValue(model)} status=${originalHttpStatus(error)} name=${name}${quota ? ` ${quota}` : ''} message=${message}`);
}

class FallbackEligibleError extends Error {
  constructor(originalError) {
    super('Primary model failed and can use the fallback model');
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
  if (provider !== 'gemini') throw new LlmError(503, `LLM_PROVIDER "${provider}" is not supported. Set it to "gemini".`);
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

function retryableFailure(error, emittedOutput) {
  if (emittedOutput) throw safeLlmError(error);
  throw new FallbackEligibleError(error);
}

async function runPrimary(operation, { signal, callerSignal, timeoutSignal }, model) {
  let overloadRetries = 0;
  let perMinuteRetries = 0;
  let genericRetries = 0;

  while (true) {
    if (callerSignal?.aborted || signal.aborted) return { aborted: true };
    if (timeoutSignal.aborted) throw timeoutError();
    let emittedOutput = false;
    try {
      const value = await raceWithSignal(
        Promise.resolve().then(() => operation(signal, () => { emittedOutput = true; })),
        signal
      );
      return { value, aborted: false };
    } catch (error) {
      if (timeoutSignal.aborted) throw timeoutError();
      if (callerSignal?.aborted || (signal.aborted && !isTimeout(signal, timeoutSignal))) return { aborted: true };
      if (error instanceof LlmError) throw error;

      const policy = classifyError(error);
      logModelFailure(model, error);
      if (policy.status === 429) {
        if (policy.perDay) retryableFailure(error, emittedOutput);
        if (perMinuteRetries > 0) retryableFailure(error, emittedOutput);
        if (policy.perMinute && perMinuteRetries === 0 && !emittedOutput) {
          perMinuteRetries += 1;
          const waited = await waitForRetry(perMinuteWaitMs, signal);
          if (!waited) {
            if (timeoutSignal.aborted) throw timeoutError();
            return { aborted: true };
          }
          continue;
        }
        retryableFailure(error, emittedOutput);
      }

      if ((overloadRetries > 0 || perMinuteRetries > 0) && policy.retryable) {
        retryableFailure(error, emittedOutput);
      }
      if (policy.overloaded && overloadRetries === 0 && !emittedOutput) {
        overloadRetries += 1;
        const waited = await waitForRetry(overloadWaitMs, signal);
        if (!waited) {
          if (timeoutSignal.aborted) throw timeoutError();
          return { aborted: true };
        }
        continue;
      }
      if (policy.status >= 500 && policy.status < 600 && !policy.overloaded
        && genericRetries < 2 && !emittedOutput) {
        const waited = await waitForRetry(genericRetryBaseMs * (2 ** genericRetries), signal);
        genericRetries += 1;
        if (!waited) {
          if (timeoutSignal.aborted) throw timeoutError();
          return { aborted: true };
        }
        continue;
      }
      if (policy.retryable) retryableFailure(error, emittedOutput);
      throw safeLlmError(error);
    }
  }
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
    if (!(error instanceof LlmError)) logModelFailure(model, error);
    throw error instanceof LlmError ? error : safeLlmError(error);
  }
}

async function generateWithFallback(operation, primaryModel, signals) {
  try {
    return await runPrimary(operation(primaryModel), signals, primaryModel);
  } catch (error) {
    const fallbackModel = getFallbackModel(primaryModel);
    if (!(error instanceof FallbackEligibleError) || !fallbackModel) {
      if (error instanceof FallbackEligibleError) throw safeLlmError(error.originalError);
      throw error;
    }
    try {
      const result = await runFallback(operation(fallbackModel), fallbackModel, signals);
      if (!result.aborted) console.info(`fallback used: ${fallbackModel}`);
      return result;
    } catch (fallbackError) {
      if (fallbackError?.status === 504) throw fallbackError;
      const publicError = fallbackError instanceof LlmError
        ? fallbackError
        : safeLlmError(fallbackError);
      publicError.message = QUOTA_MESSAGE;
      publicError.publicMessage = QUOTA_MESSAGE;
      throw publicError;
    }
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
  waitForRetry = options.waitForRetry || waitWithAbort;
  overloadWaitMs = options.overloadWaitMs ?? DEFAULT_OVERLOAD_WAIT_MS;
  perMinuteWaitMs = options.perMinuteWaitMs ?? DEFAULT_PER_MINUTE_WAIT_MS;
  genericRetryBaseMs = options.genericRetryBaseMs ?? GENERIC_RETRY_BASE_MS;
}
