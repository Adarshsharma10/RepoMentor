import { Octokit } from 'octokit';
import { Repo } from '../models/Repo.js';
import { Chunk } from '../models/Chunk.js';
import { embedDocuments } from './embeddings.js';

const MAX_FILES = 500;
const MAX_CHUNKS = 1500;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_EMBEDDING_TEXT_LENGTH = 6000;
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const EXCLUDED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
const TEXT_EXTENSIONS = new Map([
  ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
  ['ts', 'typescript'], ['tsx', 'typescript'], ['mts', 'typescript'], ['cts', 'typescript'],
  ['py', 'python'], ['pyi', 'python'], ['java', 'java'], ['kt', 'kotlin'], ['kts', 'kotlin'],
  ['go', 'go'], ['rs', 'rust'], ['c', 'c'], ['h', 'c'], ['cc', 'cpp'], ['cpp', 'cpp'], ['cxx', 'cpp'],
  ['hpp', 'cpp'], ['hh', 'cpp'], ['cs', 'csharp'], ['fs', 'fsharp'], ['php', 'php'], ['rb', 'ruby'],
  ['swift', 'swift'], ['scala', 'scala'], ['sc', 'scala'], ['sh', 'shell'], ['bash', 'shell'],
  ['zsh', 'shell'], ['sql', 'sql'], ['html', 'html'], ['htm', 'html'], ['css', 'css'],
  ['scss', 'scss'], ['sass', 'sass'], ['less', 'less'], ['json', 'json'], ['jsonc', 'json'],
  ['yaml', 'yaml'], ['yml', 'yaml'], ['toml', 'toml'], ['md', 'markdown'], ['mdx', 'markdown'],
  ['txt', 'text'], ['xml', 'xml'], ['svg', 'xml'], ['vue', 'vue'], ['svelte', 'svelte'],
  ['astro', 'astro'], ['graphql', 'graphql'], ['gql', 'graphql'], ['proto', 'protobuf'],
  ['tf', 'hcl'], ['hcl', 'hcl'], ['dockerfile', 'dockerfile'], ['ipynb', 'json']
]);
const TEXT_FILENAMES = new Map([
  ['dockerfile', 'dockerfile'], ['makefile', 'makefile'], ['gemfile', 'ruby'],
  ['procfile', 'text'], ['license', 'text'], ['readme', 'markdown'], ['.gitignore', 'text'],
  ['.dockerignore', 'text'], ['.editorconfig', 'text'], ['.npmrc', 'text'], ['.nvmrc', 'text']
]);

export class IngestionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.publicMessage = message;
  }
}

function createOctokit() {
  return new Octokit(process.env.GITHUB_TOKEN ? { auth: process.env.GITHUB_TOKEN } : {});
}

function languageForPath(filePath) {
  const baseName = filePath.split('/').at(-1).toLowerCase();
  if (TEXT_FILENAMES.has(baseName)) return TEXT_FILENAMES.get(baseName);
  const extension = baseName.includes('.') ? baseName.split('.').at(-1) : '';
  return TEXT_EXTENSIONS.get(extension) || null;
}

function isIndexableFile(file) {
  if (file.type !== 'blob' || !file.path || file.path.startsWith('/')) return false;
  const pathParts = file.path.split('/');
  const baseName = pathParts.at(-1).toLowerCase();
  if (pathParts.some(part => EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) return false;
  if (EXCLUDED_FILES.has(baseName) || baseName.endsWith('.lock')) return false;
  if (/\.min\.[^.]+$/i.test(baseName)) return false;
  if (file.size > MAX_FILE_BYTES) return false;
  return Boolean(languageForPath(file.path));
}

function chunkFile(filePath, language, code) {
  const lines = code.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const chunks = [];
  for (let start = 0; start < lines.length;) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    chunks.push({
      filePath,
      startLine: start + 1,
      endLine: end,
      language,
      code: lines.slice(start, end).join('\n')
    });
    if (end === lines.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await callback(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function translateGitHubError(error) {
  const status = error.status || error.response?.status;
  const message = error.message || '';
  const remaining = error.response?.headers?.['x-ratelimit-remaining'];
  if (status === 429 || (status === 403 && (remaining === '0' || /rate limit|secondary rate/i.test(message)))) {
    return new IngestionError(status === 403 ? 403 : 429, 'GitHub API rate limit reached. Try again later.');
  }
  if (status === 404 || status === 403) {
    return new IngestionError(404, 'Repository not found or is private/inaccessible to this GitHub token.');
  }
  return error;
}

async function fetchAndChunkFile(octokit, owner, repo, branch, file) {
  const result = await octokit.rest.git.getBlob({ owner, repo, file_sha: file.sha });
  const code = Buffer.from(result.data.content, 'base64').toString('utf8');
  if (code.includes('\0')) return null;
  return chunkFile(file.path, languageForPath(file.path), code);
}

export async function ingestRepository(repoDocument) {
  const repoId = repoDocument._id;
  const userId = repoDocument.userId;
  await Repo.updateOne({ _id: repoId }, { $set: { status: 'indexing', errorMessage: '' } });

  try {
    const octokit = createOctokit();
    const repositoryResponse = await octokit.rest.repos.get({ owner: repoDocument.owner, repo: repoDocument.name });
    const defaultBranch = repositoryResponse.data.default_branch;
    await Repo.updateOne({ _id: repoId }, { $set: { defaultBranch } });
    const treeResponse = await octokit.rest.git.getTree({
      owner: repoDocument.owner,
      repo: repoDocument.name,
      tree_sha: defaultBranch,
      recursive: 'true'
    });
    if (treeResponse.data.truncated) {
      throw new IngestionError(413, 'Repository is too large to index: GitHub truncated its file tree.');
    }

    const files = treeResponse.data.tree.filter(isIndexableFile);
    if (files.length > MAX_FILES) {
      throw new IngestionError(413, `Repository is too large to index: it has more than ${MAX_FILES} supported files.`);
    }

    let chunkCount = 0;
    let chunkLimitError;
    const fileChunks = await mapWithConcurrency(files, 5, async file => {
      if (chunkLimitError) throw chunkLimitError;
      const result = await fetchAndChunkFile(octokit, repoDocument.owner, repoDocument.name, defaultBranch, file);
      if (chunkLimitError) return null;
      if (result && chunkCount + result.length > MAX_CHUNKS) {
        chunkLimitError = new IngestionError(413, `Repository is too large to index: it has more than ${MAX_CHUNKS} chunks.`);
        throw chunkLimitError;
      }
      if (result) chunkCount += result.length;
      return result;
    });
    const indexedFiles = fileChunks.filter(result => result !== null);
    const chunks = indexedFiles.flat().map(chunk => ({ ...chunk, repoId, userId }));
    if (chunks.length > MAX_CHUNKS) {
      throw new IngestionError(413, `Repository is too large to index: it has more than ${MAX_CHUNKS} chunks.`);
    }

    const embeddingTexts = chunks.map(chunk =>
      `File: ${chunk.filePath}\n${chunk.code}`.slice(0, MAX_EMBEDDING_TEXT_LENGTH)
    );
    const embeddings = await embedDocuments(embeddingTexts);
    chunks.forEach((chunk, index) => { chunk.embedding = embeddings[index]; });

    await Chunk.deleteMany({ repoId, userId });
    if (chunks.length) await Chunk.insertMany(chunks, { ordered: true });
    return await Repo.findByIdAndUpdate(repoId, {
      $set: { defaultBranch, status: 'ready', errorMessage: '', fileCount: indexedFiles.length, chunkCount: chunks.length }
    }, { new: true });
  } catch (error) {
    await Chunk.deleteMany({ repoId, userId });
    const handledError = error.publicMessage ? error : translateGitHubError(error);
    const errorMessage = handledError.publicMessage || 'Repository ingestion failed. Please try again.';
    await Repo.updateOne({ _id: repoId }, {
      $set: { status: 'failed', errorMessage, fileCount: 0, chunkCount: 0 }
    });
    throw handledError;
  }
}
