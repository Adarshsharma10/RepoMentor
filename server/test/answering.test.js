import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSnippetPrompt,
  cleanCitationMarkers,
  isGroundedAnswer,
  NOT_FOUND_ANSWER,
  isOverviewQuestion,
  resolveMinimumRetrievalScore,
  selectAnswerContext,
  sourceFence
} from '../src/services/answering.js';
import { buildRepositoryOverview, resolveMaxChunks } from '../src/services/ingestion.js';

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

test('recognizes only broad overview questions', () => {
  for (const question of [
    'What does this project do?', 'What is this repo?', 'overview',
    'Summarize the app', 'Explain this codebase', 'tech stack', 'technologies',
    'architecture', 'main features', 'what is it about', 'how does the project work', 'how to run'
  ]) assert.equal(isOverviewQuestion(question), true, question);

  for (const question of [
    'how the jwt work', 'how does login work', 'what is the currency of france',
    'What does this project do and how does JWT work?'
  ]) assert.equal(isOverviewQuestion(question), false, question);
});

test('uses the repository overview for broad questions below threshold', () => {
  const result = selectAnswerContext('What does this project do?', [
    { ...sources[0], score: 0.2, language: 'javascript' }
  ], 'A repository that answers questions about source code.', 0.78);
  assert.equal(result.refused, false);
  assert.equal(result.sources[0].filePath, 'README.md');
  assert.equal(result.sources[0].kind, 'overview');
  assert.equal(result.sources[0].n, 1);
  assert.equal(result.sources[1].n, 2);
});

test('refuses low-score specific questions and broad questions without an overview', () => {
  const lowResult = [{ ...sources[0], score: 0.2, language: 'javascript' }];
  assert.deepEqual(selectAnswerContext('how does login work', lowResult, 'Overview', 0.78), {
    refused: true, sources: []
  });
  assert.deepEqual(selectAnswerContext('what does this project do', lowResult, '', 0.78), {
    refused: true, sources: []
  });
});

test('uses a configurable 400 chunk safety limit by default', () => {
  assert.equal(resolveMaxChunks(undefined), 400);
  assert.equal(resolveMaxChunks(''), 400);
  assert.equal(resolveMaxChunks('not-a-number'), 400);
  assert.equal(resolveMaxChunks('250'), 250);
});

test('repository overview includes README, package details without versions, and folders', () => {
  const overview = buildRepositoryOverview({
    readme: `# Demo\n${'r'.repeat(2600)}`,
    packageJson: JSON.stringify({
      name: 'demo-app',
      description: 'A demo repository',
      scripts: { start: 'node index.js' },
      dependencies: { react: '18.3.1' }
    }),
    folders: ['client', 'server']
  });
  assert.ok(overview.length <= 4000);
  assert.ok(overview.includes('README:\n# Demo'));
  assert.ok(overview.includes('Name: demo-app'));
  assert.ok(overview.includes('Scripts: start: node index.js'));
  assert.ok(overview.includes('Dependencies: react'));
  assert.ok(overview.includes('Top-level folders: client, server'));
  assert.ok(!overview.includes('18.3.1'));
});

test('uses a longer code fence when snippets contain backticks and marks truncation', () => {
  assert.equal(sourceFence('const value = ```;'), '````');
  const fenced = buildSnippetPrompt([{ ...sources[0], code: 'const value = ```;' }]);
  assert.match(fenced, /\n````\nconst value = ```;\n````$/);

  const longPrompt = buildSnippetPrompt([{ ...sources[0], code: 'x'.repeat(4001) }]);
  assert.match(longPrompt, /\n\[truncated\]\n```$/);
});
