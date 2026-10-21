import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import 'dotenv/config';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { validateEnvironment } from './config/environment.js';
import { Repo } from './models/Repo.js';

const PORT = Number(process.env.PORT || 4000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const { MONGODB_URI } = process.env;
try {
  validateEnvironment({ ...process.env, NODE_ENV });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

try {
  await connectDatabase(MONGODB_URI);
  await Repo.updateMany(
    { status: 'indexing' },
    { $set: { status: 'failed', errorMessage: 'Indexing was interrupted. Delete and add it again.' } }
  );
  const server = createApp().listen(PORT, () => console.log(`RepoMentor API listening on port ${PORT} (${NODE_ENV})`));
  let shuttingDown = false;
  process.once('SIGTERM', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('SIGTERM received; closing the API server.');
    server.close(async error => {
      try {
        await mongoose.disconnect();
        console.log('MongoDB connection closed.');
      } catch (disconnectError) {
        console.error('Could not close MongoDB cleanly:', disconnectError.message);
        process.exit(1);
      }
      if (error) {
        console.error('Could not close the API server cleanly:', error.message);
        process.exit(1);
      }
      process.exit(0);
    });
  });
} catch (error) {
  console.error('Could not start the API:', error.message);
  process.exit(1);
}
