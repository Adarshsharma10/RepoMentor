import test from 'node:test';
import assert from 'node:assert/strict';
import { getAllowedCorsOrigins, parseCorsOrigins, validateEnvironment } from '../src/config/environment.js';
import {
  DailyAskLimitError,
  getGlobalDailyAskLimit,
  reserveDailyModelCall
} from '../src/services/dailyAskLimit.js';

test('parses comma-separated CORS origins and limits production to the configured list', () => {
  assert.deepEqual(parseCorsOrigins(' https://app.example,https://admin.example, ,https://app.example '), [
    'https://app.example', 'https://admin.example'
  ]);
  assert.deepEqual(getAllowedCorsOrigins({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.example' }), ['https://app.example']);
  assert.deepEqual(getAllowedCorsOrigins({ NODE_ENV: 'development', CORS_ORIGIN: '' }), ['http://localhost:5173']);
});

test('requires production CORS_ORIGIN and JWT_SECRET configuration', () => {
  assert.throws(() => validateEnvironment({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) }), /CORS_ORIGIN/);
  assert.throws(() => validateEnvironment({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.example' }), /JWT_SECRET/);
  assert.doesNotThrow(() => validateEnvironment({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.example', JWT_SECRET: 'x'.repeat(32) }));
});

test('uses the default daily limit and refuses reservations after the cap', async () => {
  assert.equal(getGlobalDailyAskLimit(), 200);
  assert.equal(getGlobalDailyAskLimit(''), 200);
  assert.equal(getGlobalDailyAskLimit('invalid'), 200);
  assert.equal(getGlobalDailyAskLimit('3'), 3);
  assert.match(new DailyAskLimitError().publicMessage, /Cached questions still work/);

  let record;
  const fakeModel = {
    async updateOne(_filter, update) {
      if (!record) record = { count: update.$setOnInsert.count };
    },
    async findOneAndUpdate(_filter, update) {
      if (record.count >= 2) return null;
      record.count += update.$inc.count;
      return { count: record.count };
    }
  };
  const now = new Date('2026-10-21T12:00:00.000Z');
  assert.equal(await reserveDailyModelCall({ model: fakeModel, limit: 2, now }), 1);
  assert.equal(await reserveDailyModelCall({ model: fakeModel, limit: 2, now }), 2);
  await assert.rejects(reserveDailyModelCall({ model: fakeModel, limit: 2, now }), DailyAskLimitError);
});
