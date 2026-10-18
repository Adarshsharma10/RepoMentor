import { Chunk } from '../models/Chunk.js';

export function isMissingVectorIndex(error) {
  return /index.*(not found|does not exist|missing)|(?:not found|missing).*index|vector search.*index|needs to be indexed as.*vector/i.test(error?.message || '');
}

// Keep vector-search settings here so the API and evaluation script use the same query.
export async function retrieveChunks(repoId, queryVector, limit = 5) {
  return Chunk.aggregate([
    {
      $vectorSearch: {
        index: 'chunk_vector_index',
        path: 'embedding',
        queryVector,
        numCandidates: 100,
        limit,
        filter: { repoId }
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
}
