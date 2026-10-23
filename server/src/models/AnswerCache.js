import mongoose from 'mongoose';

const sourceSchema = new mongoose.Schema({
  n: { type: Number, required: true, min: 1 },
  filePath: { type: String, required: true },
  startLine: { type: Number, required: true, min: 1 },
  endLine: { type: Number, required: true, min: 1 },
  language: { type: String, required: true },
  symbol: { type: String, default: '' },
  kind: { type: String, default: '' },
  code: { type: String, required: true }
}, { _id: false });

const answerCacheSchema = new mongoose.Schema({
  repoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Repo', required: true },
  questionHash: { type: String, required: true },
  answer: { type: String, required: true },
  sources: { type: [sourceSchema], default: [] },
  createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 60 * 60 }
}, { versionKey: false });

answerCacheSchema.index({ repoId: 1, questionHash: 1 }, { unique: true });

export const AnswerCache = mongoose.model('AnswerCache', answerCacheSchema);
