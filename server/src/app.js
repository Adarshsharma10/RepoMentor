import express from 'express';
import cors from 'cors';
import authRouter from './routes/auth.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();
  app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
  app.use(express.json({ limit: '10kb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: 'connected' }));
  app.use('/api/auth', authRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
