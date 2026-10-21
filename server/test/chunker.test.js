import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkFile } from '../src/services/chunker.js';

function assertFullCoverage(content, chunks) {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    assert.ok(chunks.some(chunk => index + 1 >= chunk.startLine && index + 1 <= chunk.endLine), `line ${index + 1} was not covered`);
  }
}

test('JavaScript chunks use 1-based lines and keep header and named function metadata', async () => {
  const content = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const base = 2;',
    'const offset = 1;',
    'const scale = 3;',
    '',
    'function calculate(value) {',
    '  const first = value + base + offset;',
    '  const second = first * scale;',
    '  const third = second - 1;',
    '  const fourth = third + path.sep.length;',
    '  return fourth;',
    '}'
  ].join('\n');
  const chunks = await chunkFile({ filePath: 'src/calculate.js', language: 'javascript', content });
  assertFullCoverage(content, chunks);
  assert.ok(chunks.some(chunk => chunk.kind === 'function' && chunk.symbol === 'calculate' && chunk.startLine === 7 && chunk.endLine === 13));
  assert.ok(chunks.some(chunk => chunk.kind === 'header' && chunk.startLine === 1 && chunk.endLine === 5));
});

test('exported async generator chunks use the generator name as their symbol', async () => {
  const content = [
    'export async function* readRecords() {',
    '  const first = 1;',
    '  yield first;',
    '  yield first + 1;',
    '  return;',
    '}'
  ].join('\n');
  const chunks = await chunkFile({ filePath: 'src/records.js', language: 'javascript', content });
  assert.ok(chunks.some(chunk => chunk.kind === 'function' && chunk.symbol === 'readRecords'));
});

test('TypeScript interface and TSX exported arrow function are recognized', async () => {
  const typescript = [
    'export interface UserProfile {',
    '  id: string;',
    '  name: string;',
    '  email: string;',
    '  active: boolean;',
    '  createdAt: Date;',
    '}'
  ].join('\n');
  const tsx = [
    'import React from "react";',
    'export const Profile = () => {',
    '  const title = "Profile";',
    '  const subtitle = "Details";',
    '  const status = "Ready";',
    '  return <section>{title}{subtitle}{status}</section>;',
    '};'
  ].join('\n');
  const interfaceChunks = await chunkFile({ filePath: 'src/profile.ts', language: 'typescript', content: typescript });
  const tsxChunks = await chunkFile({ filePath: 'src/Profile.tsx', language: 'typescript', content: tsx });
  assertFullCoverage(typescript, interfaceChunks);
  assertFullCoverage(tsx, tsxChunks);
  assert.ok(interfaceChunks.some(chunk => chunk.kind === 'interface' && chunk.symbol === 'UserProfile'));
  assert.ok(tsxChunks.some(chunk => chunk.kind === 'function' && chunk.symbol === 'Profile'));
});

test('Python functions are parsed and all source lines stay covered', async () => {
  const content = [
    'import os',
    '',
    'def build_path(root, name):',
    '    first = os.path.join(root, name)',
    '    second = first.strip()',
    '    third = second.lower()',
    '    fourth = third.replace(" ", "-")',
    '    return fourth'
  ].join('\n');
  const chunks = await chunkFile({ filePath: 'src/path.py', language: 'python', content });
  assertFullCoverage(content, chunks);
  assert.ok(chunks.some(chunk => chunk.kind === 'function' && chunk.symbol === 'build_path'));
});

test('short AST chunks merge into their neighbor', async () => {
  const content = [
    'function tiny() { return 1; }',
    'function substantial(value) {',
    '  const one = value + 1;',
    '  const two = one + 1;',
    '  const three = two + 1;',
    '  const four = three + 1;',
    '  return four;',
    '}'
  ].join('\n');
  const chunks = await chunkFile({ filePath: 'src/merge.js', language: 'javascript', content });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 8);
  assert.match(chunks[0].symbol, /substantial/);
  assertFullCoverage(content, chunks);
});

test('chunks longer than 150 lines split with 10 lines of overlap and retain the symbol', async () => {
  const body = Array.from({ length: 165 }, (_, index) => `  value += ${index + 1};`).join('\n');
  const content = `function accumulate() {\n  let value = 0;\n${body}\n  return value;\n}`;
  const chunks = await chunkFile({ filePath: 'src/long.js', language: 'javascript', content });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.endLine - chunk.startLine + 1 <= 150));
  assert.equal(chunks[1].startLine, chunks[0].endLine - 9);
  assert.ok(chunks.every(chunk => chunk.symbol === 'accumulate'));
  assertFullCoverage(content, chunks);
});

test('large classes are chunked by method and retain the class name in each symbol', async () => {
  const body = Array.from({ length: 160 }, (_, index) => `    this.value += ${index + 1};`).join('\n');
  const content = `class LargeCounter {\n  process() {\n    this.value = 0;\n${body}\n    return this.value;\n  }\n}`;
  const chunks = await chunkFile({ filePath: 'src/counter.js', language: 'javascript', content });
  assert.ok(chunks.some(chunk => chunk.kind === 'method' && chunk.symbol === 'LargeCounter.process'));
  assert.ok(chunks.filter(chunk => chunk.kind === 'method').every(chunk => chunk.symbol.includes('LargeCounter')));
  assertFullCoverage(content, chunks);
});

test('syntax errors and unsupported languages use the 60-line fallback', async () => {
  const lines = Array.from({ length: 75 }, (_, index) => `line ${index + 1};`);
  const content = lines.join('\n');
  const unsupported = await chunkFile({ filePath: 'src/file.java', language: 'java', content });
  const invalidJavaScript = await chunkFile({ filePath: 'src/broken.js', language: 'javascript', content: 'function broken( {' });
  assert.equal(unsupported[0].startLine, 1);
  assert.equal(unsupported[0].endLine, 60);
  assert.equal(unsupported[1].startLine, 51);
  assert.equal(unsupported[1].endLine, 75);
  assert.equal(invalidJavaScript[0].kind, 'lines');
  assert.equal(invalidJavaScript[0].startLine, 1);
});

test('Markdown chunks split at headings', async () => {
  const content = '# Intro\nFirst line.\nSecond line.\nThird line.\nFourth line.\n\n## Setup\nInstall one.\nInstall two.\nInstall three.\nInstall four.\n';
  const chunks = await chunkFile({ filePath: 'README.md', language: 'markdown', content });
  assertFullCoverage(content, chunks);
  assert.deepEqual(chunks.map(chunk => chunk.symbol), ['Intro', 'Setup']);
  assert.deepEqual(chunks.map(chunk => chunk.startLine), [1, 7]);
});
