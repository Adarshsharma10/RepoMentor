import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSnippetPrompt,
  cleanCitationMarkers,
  isGroundedAnswer,
  NOT_FOUND_ANSWER,
  resolveMinimumRetrievalScore,
  sourceFence
} from '../src/services/answering.js';

const sources = [
  { n: 2, filePath: 'src/two.js', startLine: 1, endLine: 1, code: 'const two = 2;' },
  { n: 8, filePath: 'src/eight.js', startLine: 4, endLine: 4, code: 'const eight = 8;' }
];

test('cleans grouped citations and removes groups with no valid source', () => {
  assert.equal(cleanCitationMarkers('A [2, 8] B [1,3] C [99]', sources), 'A [2, 8] B C');
});

test('uses 0.78 for missing, empty, and invalid retrieval thresholds', () => {
  for (const value of [undefined, '', 'not-a-number']) {
    assert.deepEqual(resolveMinimumRetrievalScore(value), { score: 0.78, usesDefault: true });
  }
  assert.deepEqual(resolveMinimumRetrievalScore('0.64'), { score: 0.64, usesDefault: false });
});

test('marks only cited or explicit not-found answers as grounded', () => {
  assert.equal(isGroundedAnswer('Found it [2, 8].', sources), true);
  assert.equal(isGroundedAnswer('Uncited claim.', sources), false);
  assert.equal(isGroundedAnswer(NOT_FOUND_ANSWER, []), true);
});

test('uses a longer code fence when snippets contain backticks and marks truncation', () => {
  assert.equal(sourceFence('const value = ```;'), '````');
  const fenced = buildSnippetPrompt([{ ...sources[0], code: 'const value = ```;' }]);
  assert.match(fenced, /\n````\nconst value = ```;\n````$/);

  const longPrompt = buildSnippetPrompt([{ ...sources[0], code: 'x'.repeat(4001) }]);
  assert.match(longPrompt, /\n\[truncated\]\n```$/);
});
