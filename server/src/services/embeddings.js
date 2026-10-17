import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-embedding-001';
const VECTOR_DIMENSIONS = 768;
const MAX_BATCH_SIZE = 20;
const REQUEST_INTERVAL_MS = 1000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;
const RATE_LIMIT_RETRY_BASE_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;

let client;
let nextRequestAt = 0;

class EmbeddingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.publicMessage = message;
  }
}

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new EmbeddingError(503, 'GEMINI_API_KEY is required to create or search embeddings. Add it to server/.env.');
  }
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

function errorStatus(error) {
  if (Number.isInteger(error.status)) return error.status;
  if (Number.isInteger(error.response?.status)) return error.response.status;
  if (Number.isInteger(error.code)) return error.code;
  const match = String(error.message || '').match(/\b(429|5\d\d)\b/);
  return match ? Number(match[1]) : 0;
}

function safeEmbeddingError(error) {
  const status = errorStatus(error);
  if (status === 429 || /resource_exhausted|rate limit/i.test(error.message || '')) {
    return new EmbeddingError(429, 'Embedding rate limit reached, try again later.');
  }
  if (status >= 500 && status < 600) {
    return new EmbeddingError(503, 'Embedding service is temporarily unavailable. Try again later.');
  }
  if (status === 400) {
    return new EmbeddingError(400, 'Gemini rejected the embedding request. Check the text and model configuration.');
  }
  if (status === 401 || status === 403) {
    return new EmbeddingError(503, 'Gemini API authentication failed. Check GEMINI_API_KEY.');
  }
  return new EmbeddingError(502, 'Could not create embeddings. Check the Gemini API configuration and try again.');
}

function isRetryable(error) {
  const status = errorStatus(error);
  return status === 429 || (status >= 500 && status < 600)
    || /resource_exhausted|rate limit/i.test(error.message || '');
}

function isRateLimit(error) {
  return errorStatus(error) === 429 || /resource_exhausted|rate limit/i.test(error.message || '');
}

async function waitForRequestSlot() {
  const now = Date.now();
  const requestAt = Math.max(now, nextRequestAt);
  nextRequestAt = requestAt + REQUEST_INTERVAL_MS;
  const waitMs = requestAt - now;
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
}

function normalizeVector(values) {
  if (!Array.isArray(values) || values.length !== VECTOR_DIMENSIONS) {
    throw new EmbeddingError(502, `Gemini returned an invalid embedding; expected ${VECTOR_DIMENSIONS} values.`);
  }
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new EmbeddingError(502, 'Gemini returned an embedding that could not be normalized.');
  }
  return values.map(value => value / magnitude);
}

async function requestEmbeddings(contents, taskType) {
  const genai = getClient();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await waitForRequestSlot();
    try {
      const response = await genai.models.embedContent({
        model: MODEL,
        contents,
        config: { taskType, outputDimensionality: VECTOR_DIMENSIONS }
      });
      if (!Array.isArray(response.embeddings) || response.embeddings.length !== contents.length) {
        throw new EmbeddingError(502, 'Gemini returned a different number of embeddings than requested.');
      }
      return response.embeddings.map(embedding => normalizeVector(embedding.values));
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (attempt < MAX_ATTEMPTS && isRetryable(error)) {
        const baseDelay = isRateLimit(error) ? RATE_LIMIT_RETRY_BASE_MS : RETRY_BASE_MS;
        const delay = Math.min(baseDelay * (2 ** (attempt - 1)), MAX_RETRY_DELAY_MS);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw safeEmbeddingError(error);
    }
  }
  throw new EmbeddingError(503, 'Embedding service failed after several attempts. Try again later.');
}

export async function embedDocuments(texts) {
  if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string')) {
    throw new TypeError('embedDocuments expects an array of strings');
  }
  if (texts.length === 0) return [];

  const vectors = [];
  for (let start = 0; start < texts.length; start += MAX_BATCH_SIZE) {
    const batch = texts.slice(start, start + MAX_BATCH_SIZE);
    vectors.push(...await requestEmbeddings(batch, 'RETRIEVAL_DOCUMENT'));
  }
  return vectors;
}

export async function embedQuery(text) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('embedQuery expects a non-empty string');
  const [vector] = await requestEmbeddings([text], 'RETRIEVAL_QUERY');
  return vector;
}
