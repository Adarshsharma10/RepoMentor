import path from 'node:path';
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const WASM_DIRECTORY = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
const FALLBACK_LINES = 60;
const FALLBACK_OVERLAP = 10;
const MAX_CHUNK_LINES = 150;
const SPLIT_OVERLAP = 10;
const CLASS_METHOD_THRESHOLD = 120;

const GRAMMAR_FILES = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm'
};

let runtimePromise;
const grammarPromises = new Map();

function sourceLines(content) {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function makeChunk(lines, startLine, endLine, symbol = '', kind = 'statement') {
  return { startLine, endLine, code: lines.slice(startLine - 1, endLine).join('\n'), symbol, kind };
}

function lineChunks(lines, kind = 'lines') {
  const chunks = [];
  for (let start = 0; start < lines.length;) {
    const end = Math.min(start + FALLBACK_LINES, lines.length);
    chunks.push(makeChunk(lines, start + 1, end, '', kind));
    if (end === lines.length) break;
    start = end - FALLBACK_OVERLAP;
  }
  return chunks;
}

function nonBlankLineCount(lines, startLine, endLine) {
  let count = 0;
  for (let line = startLine - 1; line < endLine; line += 1) {
    if (lines[line]?.trim()) count += 1;
  }
  return count;
}

function combineDescriptors(left, right) {
  const priority = { method: 4, function: 4, interface: 3, class: 3, heading: 3, header: 2, markdown: 1, statement: 1, lines: 1 };
  const leftPriority = priority[left.kind] || 1;
  const rightPriority = priority[right.kind] || 1;
  const primary = rightPriority > leftPriority ? right : left;
  const symbols = [...new Set([left.symbol, right.symbol].filter(Boolean))];
  const symbol = leftPriority === rightPriority && left.kind === right.kind
    ? symbols.join(', ')
    : primary.symbol || symbols.join(', ');
  return {
    startLine: Math.min(left.startLine, right.startLine),
    endLine: Math.max(left.endLine, right.endLine),
    symbol,
    kind: primary.kind || 'statement'
  };
}

function mergeShortChunks(chunks, lines) {
  const merged = [];
  for (const chunk of chunks) {
    const previous = merged.at(-1);
    if (previous && nonBlankLineCount(lines, chunk.startLine, chunk.endLine) < 5) {
      merged[merged.length - 1] = combineDescriptors(previous, chunk);
    } else {
      merged.push({ ...chunk });
    }
  }
  if (merged.length > 1 && nonBlankLineCount(lines, merged[0].startLine, merged[0].endLine) < 5) {
    merged[1] = combineDescriptors(merged[0], merged[1]);
    merged.shift();
  }
  return merged;
}

function splitLongChunks(chunks) {
  const split = [];
  for (const chunk of chunks) {
    if (chunk.endLine - chunk.startLine + 1 <= MAX_CHUNK_LINES) {
      split.push(chunk);
      continue;
    }
    for (let startLine = chunk.startLine; startLine <= chunk.endLine;) {
      const endLine = Math.min(startLine + MAX_CHUNK_LINES - 1, chunk.endLine);
      split.push({ ...chunk, startLine, endLine });
      if (endLine === chunk.endLine) break;
      startLine = endLine - SPLIT_OVERLAP + 1;
    }
  }
  return split;
}

function finalizeChunks(descriptors, lines) {
  const sorted = descriptors
    .filter(chunk => chunk.startLine <= chunk.endLine && chunk.startLine >= 1)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const completed = [];
  for (let line = 1; line <= lines.length; line += 1) {
    if (!lines[line - 1].trim() || sorted.some(chunk => line >= chunk.startLine && line <= chunk.endLine)) continue;
    sorted.push({ startLine: line, endLine: line, symbol: '', kind: 'statement' });
  }
  sorted.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  completed.push(...splitLongChunks(mergeShortChunks(sorted, lines)));
  return completed.map(chunk => makeChunk(lines, chunk.startLine, chunk.endLine, chunk.symbol, chunk.kind));
}

function nodeStartLine(node) {
  return node.startPosition.row + 1;
}

function nodeEndLine(node) {
  return node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0);
}

function namedText(node, field = 'name') {
  return node.childForFieldName(field)?.text || '';
}

function descendantsOfTypes(node, types) {
  return types.flatMap(type => node.descendantsOfType(type) || []);
}

function getDeclaration(node) {
  return node.type === 'export_statement' ? node.childForFieldName('declaration') : node;
}

function pythonDecoratedDeclaration(node, expectedType) {
  if (node.type !== 'decorated_definition') return node;
  return descendantsOfTypes(node, [expectedType])[0] || node;
}

function hasTopLevelArrow(node) {
  return descendantsOfTypes(node, ['arrow_function']).length > 0;
}

function headerNode(node, language, exported = false) {
  if (node.type === 'comment') return true;
  if (language === 'python') {
    if (['import_statement', 'import_from_statement'].includes(node.type)) return true;
    if (node.type === 'expression_statement') {
      return descendantsOfTypes(node, ['assignment', 'augmented_assignment', 'named_expression']).length > 0;
    }
    return false;
  }
  if (node.type === 'import_statement') return true;
  if (['lexical_declaration', 'variable_declaration'].includes(node.type)) return !(exported && hasTopLevelArrow(node));
  return false;
}

function pythonMethodNode(node) {
  return node.type === 'function_definition' || node.type === 'decorated_definition';
}

function memberName(node) {
  if (node.type === 'decorated_definition') {
    const definition = descendantsOfTypes(node, ['function_definition'])[0];
    return definition ? namedText(definition) : '';
  }
  return namedText(node);
}

function classDescriptors(node, language) {
  const className = namedText(node) || 'anonymous class';
  const startLine = nodeStartLine(node);
  const endLine = nodeEndLine(node);
  if (endLine - startLine + 1 <= CLASS_METHOD_THRESHOLD) {
    return [{ startLine, endLine, symbol: className, kind: 'class' }];
  }

  const body = node.childForFieldName('body');
  if (!body) return [{ startLine, endLine, symbol: className, kind: 'class' }];
  const methods = language === 'python'
    ? body.namedChildren.filter(pythonMethodNode)
    : body.namedChildren.filter(member => ['method_definition', 'method_signature'].includes(member.type));
  if (!methods.length) return [{ startLine, endLine, symbol: className, kind: 'class' }];

  const chunks = [];
  let cursor = startLine;
  for (const method of methods) {
    const methodStart = nodeStartLine(method);
    const methodEnd = nodeEndLine(method);
    if (cursor < methodStart) chunks.push({ startLine: cursor, endLine: methodStart - 1, symbol: className, kind: 'class' });
    chunks.push({
      startLine: methodStart,
      endLine: methodEnd,
      symbol: `${className}.${memberName(method) || 'method'}`,
      kind: 'method'
    });
    cursor = Math.max(cursor, methodEnd + 1);
  }
  if (cursor <= endLine) chunks.push({ startLine: cursor, endLine, symbol: className, kind: 'class' });
  return chunks;
}

function topLevelDescriptors(root, language) {
  const descriptors = [];
  let header = null;
  function flushHeader() {
    if (header) descriptors.push(header);
    header = null;
  }

  for (const node of root.namedChildren) {
    let declaration = getDeclaration(node);
    if (language === 'python') {
      declaration = pythonDecoratedDeclaration(node, 'function_definition');
      if (declaration === node) declaration = pythonDecoratedDeclaration(node, 'class_definition');
    }
    if (headerNode(declaration, language, node.type === 'export_statement')) {
      const next = { startLine: nodeStartLine(node), endLine: nodeEndLine(node), symbol: '', kind: 'header' };
      header = header ? combineDescriptors(header, next) : next;
      header.kind = 'header';
      continue;
    }
    flushHeader();

    if (['function_declaration', 'function_definition'].includes(declaration.type)) {
      descriptors.push({ startLine: nodeStartLine(node), endLine: nodeEndLine(node), symbol: namedText(declaration) || 'anonymous function', kind: 'function' });
    } else if (['class_declaration', 'class_definition', 'abstract_class_declaration'].includes(declaration.type)) {
      const chunks = classDescriptors(declaration, language);
      chunks[0].startLine = Math.min(chunks[0].startLine, nodeStartLine(node));
      chunks.at(-1).endLine = Math.max(chunks.at(-1).endLine, nodeEndLine(node));
      descriptors.push(...chunks);
    } else if (declaration.type === 'interface_declaration') {
      descriptors.push({ startLine: nodeStartLine(node), endLine: nodeEndLine(node), symbol: namedText(declaration) || 'interface', kind: 'interface' });
    } else if (node.type === 'export_statement' && hasTopLevelArrow(declaration)) {
      const declarators = descendantsOfTypes(declaration, ['variable_declarator']);
      const symbols = declarators.filter(item => descendantsOfTypes(item, ['arrow_function']).length)
        .map(item => namedText(item, 'name')).filter(Boolean);
      descriptors.push({ startLine: nodeStartLine(node), endLine: nodeEndLine(node), symbol: symbols.join(', ') || 'exported function', kind: 'function' });
    } else {
      descriptors.push({ startLine: nodeStartLine(node), endLine: nodeEndLine(node), symbol: '', kind: 'statement' });
    }
  }
  flushHeader();
  return descriptors;
}

function markdownDescriptors(lines) {
  const headingPattern = /^ {0,3}#{1,6}[ \t]+(.+?)\s*#*\s*$/;
  const headings = [];
  lines.forEach((line, index) => {
    const match = line.match(headingPattern);
    if (match) headings.push({ line: index + 1, symbol: match[1].trim() });
    else if (index > 0 && /^(?:=+|-{3,})\s*$/.test(line) && lines[index - 1].trim()) {
      headings.push({ line: index, symbol: lines[index - 1].trim() });
    }
  });
  if (!headings.length) return lineChunks(lines, 'markdown');

  const chunks = [];
  if (headings[0].line > 1) chunks.push({ startLine: 1, endLine: headings[0].line - 1, symbol: '', kind: 'markdown' });
  headings.forEach((heading, index) => {
    chunks.push({
      startLine: heading.line,
      endLine: headings[index + 1] ? headings[index + 1].line - 1 : lines.length,
      symbol: heading.symbol,
      kind: 'heading'
    });
  });
  return finalizeChunks(chunks, lines);
}

function grammarFor(filePath, language) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.tsx') return 'tsx';
  if (language === 'javascript') return 'javascript';
  if (language === 'typescript') return 'typescript';
  if (language === 'python') return 'python';
  return null;
}

async function getGrammar(grammarName) {
  if (!runtimePromise) runtimePromise = Parser.init();
  await runtimePromise;
  if (!grammarPromises.has(grammarName)) {
    const grammarPath = path.join(WASM_DIRECTORY, GRAMMAR_FILES[grammarName]);
    grammarPromises.set(grammarName, Language.load(grammarPath));
  }
  return grammarPromises.get(grammarName);
}

export async function chunkFile({ filePath, language, content }) {
  if (typeof content !== 'string') throw new TypeError('chunkFile content must be a string');
  const lines = sourceLines(content);
  if (!lines.length) return [];
  if (language === 'markdown') return markdownDescriptors(lines);

  const grammarName = grammarFor(filePath, language);
  if (!grammarName) return lineChunks(lines);

  let parser;
  let tree;
  try {
    const grammar = await getGrammar(grammarName);
    parser = new Parser();
    parser.setLanguage(grammar);
    tree = parser.parse(content);
    if (!tree || tree.rootNode.hasError) return lineChunks(lines);
    return finalizeChunks(topLevelDescriptors(tree.rootNode, language), lines);
  } catch {
    return lineChunks(lines);
  } finally {
    tree?.delete();
    parser?.delete();
  }
}
