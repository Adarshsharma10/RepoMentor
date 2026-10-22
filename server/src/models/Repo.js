import mongoose from 'mongoose';

const repoSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  owner: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  url: { type: String, required: true },
  defaultBranch: { type: String, default: '' },
  overview: { type: String, default: '', maxlength: 4000 },
  status: { type: String, enum: ['pending', 'indexing', 'ready', 'failed'], default: 'pending' },
  errorMessage: { type: String, default: '' },
  fileCount: { type: Number, default: 0, min: 0 },
  chunkCount: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, default: Date.now }
});

repoSchema.index({ userId: 1, url: 1 }, { unique: true });

export const Repo = mongoose.model('Repo', repoSchema);
