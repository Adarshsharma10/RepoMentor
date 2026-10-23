import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheGroundedAnswer,
  deleteRepoAnswerCache,
  getCachedAnswerOrRun,
  getOrGenerateAnswer,
  hashQuestion
} from '../src/services/answerCache.js';
import { NOT_FOUND_ANSWER } from '../src/services/answering.js';

const repoId = 'repo-123';
const sources = [{
  n: 1,
  filePath: 'src/auth.js',
  startLine: 10,
  endLine: 12,
  language: 'javascript',
  code: 'hashPassword(password);'
}];

function makeCacheModel(entry = null) {
  const calls = { lookups: [], updates: [], deletes: [] };
  return {
    calls,
    findOne(filter) {
      calls.lookups.push(filter);
      return { lean: async () => entry };
    },
    async updateOne(...args) { calls.updates.push(args); },
    async deleteMany(filter) { calls.deletes.push(filter); }
  };
}

test('cache hit returns the saved answer without calling the generator', async () => {
  const model = makeCacheModel({ answer: 'Passwords are hashed [1].', sources });
  let modelCalls = 0;
  const result = await getOrGenerateAnswer({
    repoId,
    question: 'How are passwords hashed?',
    model,
    generate: async () => { modelCalls += 1; return { answer: 'new answer', sources }; }
  });

  assert.equal(result.cacheHit, true);
  assert.equal(result.answer, 'Passwords are hashed [1].');
  assert.equal(modelCalls, 0);
  assert.equal(model.calls.updates.length, 0);
});

test('cache hit skips embedding, vector search, and model calls', async () => {
  const model = makeCacheModel({ answer: 'Passwords are hashed [1].', sources });
  const calls = { embedding: 0, vectorSearch: 0, model: 0 };
  const result = await getCachedAnswerOrRun({
    repoId,
    question: 'How are passwords hashed?',
    model,
    onMiss: async () => {
      calls.embedding += 1;
      calls.vectorSearch += 1;
      calls.model += 1;
    }
  });

  assert.equal(result.cacheHit, true);
  assert.deepEqual(calls, { embedding: 0, vectorSearch: 0, model: 0 });
});

test('cache miss generates and stores a grounded answer', async () => {
  const model = makeCacheModel();
  const result = await getOrGenerateAnswer({
    repoId,
    question: '  HOW   are passwords hashed?!  ',
    model,
    generate: async () => ({ answer: 'Passwords are hashed [1].', sources })
  });

  assert.equal(result.cacheHit, false);
  assert.equal(result.grounded, true);
  assert.equal(model.calls.updates.length, 1);
  assert.equal(model.calls.updates[0][0].questionHash, hashQuestion('how are passwords hashed'));
  assert.equal(model.calls.updates[0][1].$set.answer, 'Passwords are hashed [1].');
});

test('not-found answers are never cached', async () => {
  const model = makeCacheModel();
  assert.equal(await cacheGroundedAnswer(repoId, 'unknown question', NOT_FOUND_ANSWER, [], model), false);
  assert.equal(model.calls.updates.length, 0);
});

test('repository deletion removes all cache entries for that repo', async () => {
  const model = makeCacheModel();
  await deleteRepoAnswerCache(repoId, model);
  assert.deepEqual(model.calls.deletes, [{ repoId }]);
});

test('question hashing ignores case, repeated whitespace, and final punctuation', () => {
  assert.equal(hashQuestion('  HOW   does this work?!  '), hashQuestion('how does this work'));
});
