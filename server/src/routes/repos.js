import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/requireAuth.js';
import { Chunk } from '../models/Chunk.js';
import { Repo } from '../models/Repo.js';
import { Message } from '../models/Message.js';
import { ingestRepository } from '../services/ingestion.js';
import { generateAnswer, streamAnswer } from '../services/llm.js';
import { isMissingVectorIndex, retrieveChunks } from '../services/retrieval.js';
import { cleanCitationMarkers, isGroundedAnswer, NOT_FOUND_ANSWER, prepareAnswer } from '../services/answering.js';
import { formatSseEvent, startSseHeartbeat } from '../services/sse.js';
import { embedQuery } from '../services/embeddings.js';
import { reserveDailyModelCall } from '../services/dailyAskLimit.js';
const router = Router();
router.use(requireAuth);

function safeLogValue(value) {
  let text = String(value ?? 'unknown').replace(/[\r\n\t]/g, ' ');
  const secrets = [process.env.GEMINI_API_KEY, process.env.GITHUB_TOKEN, process.env.JWT_SECRET, process.env.MONGODB_URI]
    .filter(Boolean);
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text.replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^,;\s]+/gi, '$1=[redacted]');
}

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

const configuredAskLimit = Number.parseInt(process.env.ASK_RATE_LIMIT_PER_HOUR || '20', 10);
const askLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number.isInteger(configuredAskLimit) && configuredAskLimit > 0 ? configuredAskLimit : 20,
  keyGenerator: req => req.auth.sub,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Question limit reached. Try again in an hour.' }
});

function getAskInput(req, res) {
  if (!isValidRepoId(req.params.id)) {
    res.status(404).json({ error: 'Repository not found' });
    return null;
  }
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (question.length < 3 || question.length > 500) {
    res.status(400).json({ error: 'Question must be 3–500 characters.' });
    return null;
  }
  return question;
}

async function requireRepoEmbeddings(repo, res, use, shouldStop = () => false) {
  if (repo.chunkCount === 0) return true;
  const hasEmbedding = await Chunk.exists({ repoId: repo._id, embedding: { $exists: true } });
  if (shouldStop()) return false;
  if (hasEmbedding) return true;
  const action = use === 'search' ? 'search' : 'questions';
  res.status(409).json({ error: `This repository was indexed before embeddings were added. Delete it and add it again to enable ${action}.` });
  return false;
}

async function getAskRepo(req, res, shouldStop = () => false) {
  if (!isValidRepoId(req.params.id)) {
    res.status(404).json({ error: 'Repository not found' });
    return null;
  }
  const repo = await Repo.findOne({ _id: req.params.id, userId: req.auth.sub });
  if (shouldStop()) return null;
  if (!repo) {
    res.status(404).json({ error: 'Repository not found' });
    return null;
  }
  if (repo.status !== 'ready') {
    res.status(409).json({ error: `Repository is not ready for questions (status: ${repo.status}).` });
    return null;
  }
  if (!await requireRepoEmbeddings(repo, res, 'questions', shouldStop)) return null;
  return repo;
}

function withVectorIndexMessage(error) {
  if (!isMissingVectorIndex(error)) return error;
  const indexError = new Error('MongoDB Atlas vector index "chunk_vector_index" is missing or not ready. Create it in the Atlas UI and try again.');
  indexError.status = 503;
  indexError.publicMessage = indexError.message;
  return indexError;
}

function sendSse(res, event, data) {
  if (res.destroyed || res.writableEnded || !res.writable) return false;
  try {
    res.write(formatSseEvent(event, data));
    return true;
  } catch {
    return false;
  }
}

function endSse(res) {
  if (res.destroyed || res.writableEnded || !res.writable) return false;
  try {
    res.end();
    return true;
  } catch {
    return false;
  }
}

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
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'This repository is already added.' });
    }
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

    if (!await requireRepoEmbeddings(repo, res, 'search')) return;

    const queryVector = await embedQuery(query);
    let results;
    try {
      results = await retrieveChunks(repo._id, queryVector, limit);
    } catch (error) {
      return next(withVectorIndexMessage(error));
    }
    return res.json({ results });
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/ask', askLimiter, async (req, res, next) => {
  try {
    const repo = await getAskRepo(req, res);
    if (!repo) return;
    const question = getAskInput(req, res);
    if (!question) return;
    let prepared;
    try {
      prepared = await prepareAnswer(repo._id, question);
    } catch (error) {
      return next(withVectorIndexMessage(error));
    }
    const sources = prepared.sources;
    let answer = NOT_FOUND_ANSWER;
    if (prepared.prompt) {
      await reserveDailyModelCall();
      answer = cleanCitationMarkers(await generateAnswer(prepared.prompt), sources);
    }
    const grounded = isGroundedAnswer(answer, sources);

    await Message.create({
      userId: req.auth.sub,
      repoId: repo._id,
      question,
      answer,
      grounded,
      sources
    });
    return res.json({ answer, sources, grounded });
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/ask/stream', askLimiter, async (req, res, next) => {
  let responseStarted = false;
  let disconnected = false;
  let disconnectLogged = false;
  let heartbeatStop;
  const generationController = new AbortController();
  const markDisconnected = () => {
    if (disconnected) return;
    disconnected = true;
    heartbeatStop?.();
    generationController.abort();
    if (!disconnectLogged) {
      disconnectLogged = true;
      console.log('client disconnected');
    }
  };
  res.on('close', () => {
    if (!res.writableEnded) markDisconnected();
  });
  if (disconnected || res.destroyed) return;

  try {
    const repo = await getAskRepo(req, res, () => disconnected);
    if (!repo || disconnected) return;
    const question = getAskInput(req, res);
    if (!question || disconnected) return;

    const beginStream = () => {
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      if (disconnected || res.destroyed) return false;
      res.flushHeaders();
      responseStarted = true;
      heartbeatStop = startSseHeartbeat(res);
      return true;
    };

    let prepared;
    try {
      prepared = await prepareAnswer(repo._id, question);
    } catch (error) {
      const streamError = withVectorIndexMessage(error);
      if (!beginStream()) return;
      throw streamError;
    }
    if (disconnected) return;
    if (prepared.prompt) {
      try {
        await reserveDailyModelCall();
      } catch (error) {
        if (error?.name === 'DailyAskLimitError') throw error;
        if (!beginStream()) return;
        throw error;
      }
    }
    if (!beginStream()) return;

    if (!sendSse(res, 'sources', prepared.sources)) {
      markDisconnected();
      return;
    }

    let answer = prepared.answer;
    if (prepared.prompt) {
      answer = '';
      for await (const text of streamAnswer({ ...prepared.prompt, signal: generationController.signal })) {
        if (disconnected) return;
        answer += text;
        if (!sendSse(res, 'token', { text })) {
          markDisconnected();
          return;
        }
      }
      answer = cleanCitationMarkers(answer, prepared.sources);
    }
    if (disconnected) return;
    const grounded = isGroundedAnswer(answer, prepared.sources);

    const message = await Message.create({
      userId: req.auth.sub,
      repoId: repo._id,
      question,
      answer,
      grounded,
      sources: prepared.sources
    });
    if (disconnected) {
      await Message.deleteOne({ _id: message._id, userId: req.auth.sub });
      return;
    }
    if (!sendSse(res, 'done', { messageId: String(message._id), answer, grounded })) {
      markDisconnected();
      await Message.deleteOne({ _id: message._id, userId: req.auth.sub });
      return;
    }
    heartbeatStop?.();
    endSse(res);
  } catch (error) {
    if (disconnected || res.destroyed || res.writableEnded) return;
    if (!responseStarted) return next(error);
    const name = safeLogValue(error?.name || 'Error');
    const status = safeLogValue(error?.status ?? error?.response?.status ?? error?.code ?? 'unknown');
    const detail = safeLogValue(error?.message || 'Unknown error');
    console.error(`[ask/stream] name=${name} status=${status} message=${detail}`);
    const message = error?.publicMessage || 'The answer could not be generated. Try again in a minute.';
    sendSse(res, 'error', { message });
    heartbeatStop?.();
    endSse(res);
  }
});

router.get('/:id/messages', async (req, res, next) => {
  try {
    if (!isValidRepoId(req.params.id)) return res.status(404).json({ error: 'Repository not found' });
    const repo = await Repo.findOne({ _id: req.params.id, userId: req.auth.sub });
    if (!repo) return res.status(404).json({ error: 'Repository not found' });
    const messages = await Message.find({ userId: req.auth.sub, repoId: repo._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    return res.json({ messages: messages.reverse() });
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
    await Message.deleteMany({ repoId: repo._id, userId: req.auth.sub });
    await Repo.deleteOne({ _id: repo._id, userId: req.auth.sub });
    return res.json({ message: 'Repository and its chunks were deleted' });
  } catch (error) {
    return next(error);
  }
});

export default router;
