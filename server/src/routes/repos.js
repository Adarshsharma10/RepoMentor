import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/requireAuth.js';
import { Chunk } from '../models/Chunk.js';
import { Repo } from '../models/Repo.js';
import { ingestRepository } from '../services/ingestion.js';
import { embedQuery } from '../services/embeddings.js';

const router = Router();
router.use(requireAuth);

const addRepoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  keyGenerator: req => req.auth.sub,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Repository add limit reached. Try again in an hour.' }
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: req => req.auth.sub,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Search limit reached. Try again in a minute.' }
});

function parseGitHubUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const input = value.trim();
  let parsed;
  try {
    parsed = new URL(input.includes('://') ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com'
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]{1,39}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) return null;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}

function isValidRepoId(id) {
  return mongoose.isValidObjectId(id);
}

router.post('/', addRepoLimiter, async (req, res, next) => {
  try {
    const parsedUrl = parseGitHubUrl(req.body?.url);
    if (!parsedUrl) return res.status(400).json({ error: 'Enter a valid GitHub repository URL, such as https://github.com/owner/name.' });

    const existingRepo = await Repo.exists({ userId: req.auth.sub, url: parsedUrl.url });
    if (existingRepo) return res.status(409).json({ error: 'This repository is already added.' });

    const repoCount = await Repo.countDocuments({ userId: req.auth.sub });
    if (repoCount >= 5) {
      return res.status(409).json({ error: 'You can add up to 5 repositories. Delete one before adding another.' });
    }

    const repo = await Repo.create({
      userId: req.auth.sub,
      ...parsedUrl,
      status: 'pending'
    });
    try {
      const indexedRepo = await ingestRepository(repo);
      return res.status(201).json({ repo: indexedRepo });
    } catch (error) {
      if (error.publicMessage) {
        const failedRepo = await Repo.findOne({ _id: repo._id, userId: req.auth.sub });
        return res.status(error.status || 500).json({ error: error.publicMessage, repo: failedRepo });
      }
      return next(error);
    }
  } catch (error) {
    return next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const repos = await Repo.find({ userId: req.auth.sub }).sort({ createdAt: -1 });
    return res.json({ repos });
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/search', searchLimiter, async (req, res, next) => {
  try {
    if (!isValidRepoId(req.params.id)) return res.status(404).json({ error: 'Repository not found' });
    const repo = await Repo.findOne({ _id: req.params.id, userId: req.auth.sub });
    if (!repo) return res.status(404).json({ error: 'Repository not found' });
    if (repo.status !== 'ready') {
      return res.status(409).json({ error: `Repository is not ready for search (status: ${repo.status}).` });
    }

    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    const limit = req.body?.limit === undefined ? 5 : req.body.limit;
    if (query.length < 3 || query.length > 500) {
      return res.status(400).json({ error: 'Search query must be 3–500 characters.' });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      return res.status(400).json({ error: 'Search limit must be a whole number from 1 to 10.' });
    }

    if (repo.chunkCount > 0) {
      const hasEmbedding = await Chunk.exists({ repoId: repo._id, embedding: { $exists: true } });
      if (!hasEmbedding) {
        return res.status(409).json({ error: 'This repository was indexed before embeddings were added. Delete it and add it again to enable search.' });
      }
    }

    const queryVector = await embedQuery(query);
    let results;
    try {
      results = await Chunk.aggregate([
        {
          $vectorSearch: {
            index: 'chunk_vector_index',
            path: 'embedding',
            queryVector,
            numCandidates: 100,
            limit,
            filter: { repoId: repo._id }
          }
        },
        {
          $project: {
            _id: 0,
            filePath: 1,
            startLine: 1,
            endLine: 1,
            language: 1,
            code: 1,
            score: { $meta: 'vectorSearchScore' }
          }
        }
      ]);
    } catch (error) {
      if (/index.*(not found|does not exist|missing)|(?:not found|missing).*index|vector search.*index|needs to be indexed as.*vector/i.test(error.message || '')) {
        const indexError = new Error('MongoDB Atlas vector index "chunk_vector_index" is missing or not ready. Create it in the Atlas UI and try again.');
        indexError.status = 503;
        indexError.publicMessage = indexError.message;
        return next(indexError);
      }
      return next(error);
    }
    return res.json({ results });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidRepoId(req.params.id)) return res.status(404).json({ error: 'Repository not found' });
    const repo = await Repo.findOne({ _id: req.params.id, userId: req.auth.sub });
    if (!repo) return res.status(404).json({ error: 'Repository not found' });
    return res.json({ repo });
  } catch (error) {
    return next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!isValidRepoId(req.params.id)) return res.status(404).json({ error: 'Repository not found' });
    const repo = await Repo.findOne({ _id: req.params.id, userId: req.auth.sub });
    if (!repo) return res.status(404).json({ error: 'Repository not found' });
    await Chunk.deleteMany({ repoId: repo._id, userId: req.auth.sub });
    await Repo.deleteOne({ _id: repo._id, userId: req.auth.sub });
    return res.json({ message: 'Repository and its chunks were deleted' });
  } catch (error) {
    return next(error);
  }
});

export default router;
