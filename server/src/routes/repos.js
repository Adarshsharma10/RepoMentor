import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/requireAuth.js';
import { Chunk } from '../models/Chunk.js';
import { Repo } from '../models/Repo.js';
import { ingestRepository } from '../services/ingestion.js';

const router = Router();
router.use(requireAuth);

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

router.post('/', async (req, res, next) => {
  try {
    const parsedUrl = parseGitHubUrl(req.body?.url);
    if (!parsedUrl) return res.status(400).json({ error: 'Enter a valid GitHub repository URL, such as https://github.com/owner/name.' });

    const repo = await Repo.create({
      userId: req.auth.sub,
      ...parsedUrl,
      status: 'pending'
    });
    try {
      const indexedRepo = await ingestRepository(repo);
      return res.status(201).json({ repo: indexedRepo });
    } catch (error) {
      if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        const failedRepo = await Repo.findOne({ _id: repo._id, userId: req.auth.sub });
        return res.status(error.status).json({ error: error.publicMessage || 'Could not index this repository.', repo: failedRepo });
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
