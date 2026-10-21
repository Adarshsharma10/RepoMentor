import mongoose from 'mongoose';

const globalDailyAskUsageSchema = new mongoose.Schema({
  _id: { type: String },
  count: { type: Number, required: true, min: 0 },
  expiresAt: { type: Date, required: true }
}, { versionKey: false });

globalDailyAskUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GlobalDailyAskUsage = mongoose.model('GlobalDailyAskUsage', globalDailyAskUsageSchema);
