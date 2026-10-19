import { GoogleGenAI } from '@google/genai';

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;
let client;

export class LlmError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.name = 'LlmError';
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function errorStatus(error) {
  if (Number.isInteger(error.status)) return error.status;
  if (Number.isInteger(error.response?.status)) return error.response.status;
  if (Number.isInteger(error.code)) return error.code;
  const match = String(error.message || '').match(/\b(429|5\d\d)\b/);
  return match ? Number(match[1]) : 0;
}

function safeLlmError(error) {
  const status = errorStatus(error);
  if (status === 429 || /resource_exhausted|rate limit|too many requests/i.test(error.message || '')) {
    return new LlmError(429, 'The answer service is rate limited. Try again shortly.');
  }
  if (status >= 500 && status < 600) return new LlmError(503, 'The answer service is temporarily unavailable. Try again later.');
  if (status === 400) return new LlmError(400, 'The answer service could not process this request.');
  if (status === 401 || status === 403) return new LlmError(503, 'The Gemini API configuration is invalid. Check GEMINI_API_KEY.');
  return new LlmError(502, 'Could not generate an answer. Check the Gemini configuration and try again.');
}

function getClient() {
  const provider = (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();
  if (provider !== 'gemini') {
    throw new LlmError(503, `LLM_PROVIDER "${provider}" is not supported. Set it to "gemini".`);
  }
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new LlmError(503, 'GEMINI_API_KEY is required to answer questions. Add it to server/.env.');
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

export async function generateAnswer({ system, user }) {
  if (typeof system !== 'string' || typeof user !== 'string') {
    throw new TypeError('generateAnswer expects system and user strings');
  }
  const genai = getClient();
  const model = process.env.LLM_MODEL?.trim() || 'gemini-2.5-flash';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await genai.models.generateContent({
        model,
        contents: user,
        config: { systemInstruction: system, temperature: 0.2, maxOutputTokens: 1024 }
      });
      const answer = response.text?.trim();
      if (!answer) throw new LlmError(502, 'The answer service returned an empty answer. Try again.');
      return answer;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const status = errorStatus(error);
      const retryable = status === 429 || (status >= 500 && status < 600)
        || /resource_exhausted|rate limit|too many requests/i.test(error.message || '');
      if (retryable && attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_BASE_MS * (2 ** attempt)));
        continue;
      }
      throw safeLlmError(error);
    }
  }

  throw new LlmError(503, 'The answer service failed after several attempts. Try again later.');
}

export async function* streamAnswer({ system, user, signal }) {
  if (typeof system !== 'string' || typeof user !== 'string') {
    throw new TypeError('streamAnswer expects system and user strings');
  }
  const genai = getClient();
  const model = process.env.LLM_MODEL?.trim() || 'gemini-2.5-flash';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let emittedText = false;
    try {
      const responseStream = await genai.models.generateContentStream({
        model,
        contents: user,
        config: { systemInstruction: system, temperature: 0.2, maxOutputTokens: 1024, abortSignal: signal }
      });
      for await (const response of responseStream) {
        const delta = typeof response.text === 'string' ? response.text : '';
        if (!delta) continue;
        emittedText = true;
        yield delta;
      }
      if (!emittedText) throw new LlmError(502, 'The answer service returned an empty answer. Try again.');
      return;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const status = errorStatus(error);
      const retryable = status === 429 || (status >= 500 && status < 600)
        || /resource_exhausted|rate limit|too many requests/i.test(error.message || '');
      if (retryable && !emittedText && attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_BASE_MS * (2 ** attempt)));
        continue;
      }
      throw safeLlmError(error);
    }
  }

  throw new LlmError(503, 'The answer service failed after several attempts. Try again later.');
}
