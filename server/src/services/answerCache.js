import { createHash } from 'node:crypto';
import { AnswerCache } from '../models/AnswerCache.js';
import { isGroundedAnswer, NOT_FOUND_ANSWER } from './answering.js';

export function normalizeCacheQuestion(question) {
  return String(question).toLowerCase().trim().replace(/\s+/g, ' ')
    .replace(/[\p{P}\s]+$/u, '').trim();
}

export function hashQuestion(question) {
  return createHash('sha256').update(normalizeCacheQuestion(question)).digest('hex');
}

export async function findCachedAnswer(repoId, question, model = AnswerCache) {
  const query = model.findOne({ repoId, questionHash: hashQuestion(question) });
  return typeof query?.lean === 'function' ? query.lean() : query;
}

// Keep the cache lookup ahead of any caller work such as embedding or retrieval.
export async function getCachedAnswerOrRun({ repoId, question, onMiss, model = AnswerCache }) {
  const cached = await findCachedAnswer(repoId, question, model);
  if (cached) return { cacheHit: true, cached };
  return { cacheHit: false, value: await onMiss() };
}

export async function cacheGroundedAnswer(repoId, question, answer, sources, model = AnswerCache) {
  if (answer === NOT_FOUND_ANSWER || !isGroundedAnswer(answer, sources)) return false;
  const filter = { repoId, questionHash: hashQuestion(question) };
  const update = { $set: { answer, sources, createdAt: new Date() } };
  try {
    await model.updateOne(filter, update, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    await model.updateOne(filter, update);
  }
  return true;
}

export async function getOrGenerateAnswer({ repoId, question, generate, model = AnswerCache }) {
  const result = await getCachedAnswerOrRun({ repoId, question, model, onMiss: generate });
  if (result.cacheHit) return { answer: result.cached.answer, sources: result.cached.sources, grounded: true, cacheHit: true };
  const generated = result.value;
  if (!generated) return null;
  const grounded = isGroundedAnswer(generated.answer, generated.sources);
  await cacheGroundedAnswer(repoId, question, generated.answer, generated.sources, model);
  return { ...generated, grounded, cacheHit: false };
}

export function deleteRepoAnswerCache(repoId, model = AnswerCache) {
  return model.deleteMany({ repoId });
}
