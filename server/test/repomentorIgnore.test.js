import test from 'node:test';
import assert from 'node:assert/strict';
import { isRepoPathIgnored, parseRepoIgnore } from '../src/services/repomentorIgnore.js';

test('RepoMentor ignore rules skip configured evaluation paths and honor comments', () => {
  const rules = parseRepoIgnore('# evaluation artifacts\nserver/eval/\nserver/eval-*.txt\n');

  assert.equal(isRepoPathIgnored('server/eval/questions.json', rules), true);
  assert.equal(isRepoPathIgnored('server/eval/baselines/eval-lines.txt', rules), true);
  assert.equal(isRepoPathIgnored('server/eval/results-20261019.json', rules), true);
  assert.equal(isRepoPathIgnored('server/eval-local.txt', rules), true);
  assert.equal(isRepoPathIgnored('server/evaluation.js', rules), false);
  assert.equal(isRepoPathIgnored('client/src/App.jsx', rules), false);
});
