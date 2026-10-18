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

const messageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  repoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Repo', required: true, index: true },
  question: { type: String, required: true },
  answer: { type: String, required: true },
  sources: { type: [sourceSchema], default: [] },
  createdAt: { type: Date, default: Date.now }
});

messageSchema.index({ userId: 1, repoId: 1, createdAt: -1 });

export const Message = mongoose.model('Message', messageSchema);
