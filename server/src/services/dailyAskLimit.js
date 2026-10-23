import { GlobalDailyAskUsage } from '../models/GlobalDailyAskUsage.js';

export const DAILY_ASK_LIMIT_MESSAGE = 'The demo has reached its daily limit. Cached questions still work.';

export function getGlobalDailyAskLimit(value = process.env.GLOBAL_DAILY_ASK_LIMIT) {
  const configured = String(value ?? '').trim();
  if (!configured) return 200;
  const limit = Number(configured);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : 200;
}

export class DailyAskLimitError extends Error {
  constructor() {
    super(DAILY_ASK_LIMIT_MESSAGE);
    this.name = 'DailyAskLimitError';
    this.status = 503;
    this.publicMessage = DAILY_ASK_LIMIT_MESSAGE;
  }
}

export async function reserveDailyModelCall({
  model = GlobalDailyAskUsage,
  limit = getGlobalDailyAskLimit(),
  now = new Date()
} = {}) {
  const day = now.toISOString().slice(0, 10);
  const expiresAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 8));

  try {
    await model.updateOne({ _id: day }, { $setOnInsert: { count: 0, expiresAt } }, { upsert: true });
  } catch (error) {
    // Parallel first requests can both try to create the same day's counter.
    if (error?.code !== 11000) throw error;
  }

  const usage = await model.findOneAndUpdate(
    { _id: day, count: { $lt: limit } },
    { $inc: { count: 1 } },
    { new: true }
  );
  if (!usage) throw new DailyAskLimitError();
  return usage.count;
}
