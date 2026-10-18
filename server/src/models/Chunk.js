import mongoose from 'mongoose';

const chunkSchema = new mongoose.Schema({
  repoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Repo', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  filePath: { type: String, required: true },
  startLine: { type: Number, required: true, min: 1 },
  endLine: { type: Number, required: true, min: 1 },
  language: { type: String, required: true },
  code: { type: String, required: true },
  symbol: { type: String, default: '' },
  kind: { type: String, default: '' },
  embedding: { type: [Number], select: false }
});

export const Chunk = mongoose.model('Chunk', chunkSchema);
