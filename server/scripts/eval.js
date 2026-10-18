import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/database.js';
import { Repo } from '../src/models/Repo.js';
import { embedQuery } from '../src/services/embeddings.js';
import { isMissingVectorIndex, retrieveChunks } from '../src/services/retrieval.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const evalDirectory = path.resolve(scriptDirectory, '../eval');
const questionsPath = path.join(evalDirectory, 'questions.json');
const projectRoot = path.resolve(scriptDirectory, '../..');
dotenv.config({ path: path.resolve(scriptDirectory, '../.env') });

function parseTopK(value) {
  const topK = Number(value ?? 5);
  if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
    throw new Error('topK must be a whole number from 1 to 100.');
  }
  return topK;
}

async function listRepos() {
  const repos = await Repo.find({}).select('_id owner name url status').sort({ createdAt: -1 }).lean();
  if (!repos.length) {
    console.log('No repositories are stored in this MongoDB database.');
    return;
  }
  for (const repo of repos) {
    console.log(`${repo.owner}/${repo.name}  ${repo._id}  (${repo.status})`);
  }
}

async function evaluateRepo(repoId, topK) {
  if (!mongoose.isValidObjectId(repoId)) throw new Error('repoId must be a valid MongoDB repository id.');
  const repo = await Repo.findById(repoId).select('_id owner name status').lean();
  if (!repo) throw new Error(`Repository ${repoId} was not found.`);
  if (repo.status !== 'ready') throw new Error(`Repository is not ready (status: ${repo.status}).`);

  const fixture = JSON.parse(await fs.readFile(questionsPath, 'utf8'));
  if (!Array.isArray(fixture.questions)) throw new Error('questions.json must contain a questions array.');
  if (!Array.isArray(fixture.negatives) || fixture.negatives.some(question => typeof question !== 'string' || !question.trim())) {
    throw new Error('questions.json must contain a negatives array of question strings.');
  }

  for (const [index, item] of fixture.questions.entries()) {
    if (typeof item.q !== 'string' || !item.q.trim() || !Array.isArray(item.expect) || item.expect.length === 0
      || item.expect.some(filePath => typeof filePath !== 'string' || !filePath.trim())) {
      throw new Error(`Question ${index + 1} must have a string q and a non-empty array of expected file paths.`);
    }
    for (const expectedPath of item.expect) {
      const absolutePath = path.resolve(projectRoot, expectedPath);
      if (!absolutePath.startsWith(`${projectRoot}${path.sep}`)) {
        throw new Error(`Expected file path must stay inside the repository: ${expectedPath}`);
      }
      try {
        await fs.access(absolutePath);
      } catch {
        throw new Error(`Expected file does not exist in this repository: ${expectedPath}`);
      }
    }
  }

  const results = [];
  for (const [index, item] of fixture.questions.entries()) {
    const queryVector = await embedQuery(item.q);
    let matches;
    try {
      matches = await retrieveChunks(repo._id, queryVector, topK);
    } catch (error) {
      if (isMissingVectorIndex(error)) {
        throw new Error('MongoDB Atlas vector index "chunk_vector_index" is missing or not ready. Create it in Atlas and retry.');
      }
      throw error;
    }
    const firstHitIndex = matches.findIndex(match => item.expect.includes(match.filePath));
    const result = {
      question: item.q,
      expectedFiles: item.expect,
      status: firstHitIndex >= 0 ? 'HIT' : 'MISS',
      firstHitRank: firstHitIndex >= 0 ? firstHitIndex + 1 : null,
      topResults: matches.map(match => ({ filePath: match.filePath, score: Number(match.score) }))
    };
    results.push(result);

    console.log(`\n${result.status}  rank: ${result.firstHitRank ?? 'none'}  ${result.question}`);
    result.topResults.forEach((match, rank) => console.log(`  ${rank + 1}. ${match.filePath}  score: ${match.score.toFixed(4)}`));
  }

  const negativeResults = [];
  for (const [index, question] of fixture.negatives.entries()) {
    const queryVector = await embedQuery(question);
    let matches;
    try {
      matches = await retrieveChunks(repo._id, queryVector, 1);
    } catch (error) {
      if (isMissingVectorIndex(error)) {
        throw new Error('MongoDB Atlas vector index "chunk_vector_index" is missing or not ready. Create it in Atlas and retry.');
      }
      throw error;
    }
    const topScore = matches.length ? Number(matches[0].score) : null;
    negativeResults.push({ question, topScore, topResult: matches[0] ? { filePath: matches[0].filePath, score: topScore } : null });
    console.log(`\nNEGATIVE ${index + 1}  top score: ${topScore === null ? 'none' : topScore.toFixed(4)}  ${question}`);
  }

  const hits = results.filter(result => result.status === 'HIT').length;
  const hitRate = results.length ? hits / results.length : 0;
  const mrr = results.length
    ? results.reduce((sum, result) => sum + (result.firstHitRank === null ? 0 : 1 / result.firstHitRank), 0) / results.length
    : 0;
  const precisionAtK = results.length
    ? results.reduce((sum, result) => sum + result.topResults.filter(match => result.expectedFiles.includes(match.filePath)).length / topK, 0) / results.length
    : 0;
  const positiveTopScores = results.map(result => result.topResults[0]?.score).filter(Number.isFinite);
  const lowestPositiveTop1Score = positiveTopScores.length ? Math.min(...positiveTopScores) : null;
  const negativeScores = negativeResults.map(result => result.topScore).filter(Number.isFinite);
  const highestNegativeScore = negativeScores.length ? Math.max(...negativeScores) : null;
  console.log(`\nHit rate: ${hits}/${results.length} (${(hitRate * 100).toFixed(1)}%)`);
  console.log(`MRR: ${mrr.toFixed(4)}`);
  console.log(`Precision@${topK}: ${precisionAtK.toFixed(4)}`);
  console.log(`Highest negative score: ${highestNegativeScore === null ? 'none' : highestNegativeScore.toFixed(4)}`);
  console.log(`Lowest positive top-1 score: ${lowestPositiveTop1Score === null ? 'none' : lowestPositiveTop1Score.toFixed(4)}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultPath = path.join(evalDirectory, `results-${timestamp}.json`);
  await fs.mkdir(evalDirectory, { recursive: true });
  await fs.writeFile(resultPath, `${JSON.stringify({
    repo: { id: String(repo._id), name: `${repo.owner}/${repo.name}` },
    topK,
    hitRate,
    mrr,
    precisionAtK,
    hits,
    total: results.length,
    highestNegativeScore,
    lowestPositiveTop1Score,
    results,
    negativeResults
  }, null, 2)}\n`);
  console.log(`Full results saved to ${path.relative(path.resolve(scriptDirectory, '..'), resultPath)}`);
}

async function main() {
  await connectDatabase(process.env.MONGODB_URI);
  if (process.argv[2] === '--list') {
    await listRepos();
    return;
  }
  const repoId = process.argv[2];
  if (!repoId) throw new Error('Usage: node scripts/eval.js <repoId> [topK=5] or node scripts/eval.js --list');
  await evaluateRepo(repoId, parseTopK(process.argv[3]));
}

try {
  await main();
} catch (error) {
  console.error(`Evaluation failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
