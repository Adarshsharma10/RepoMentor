import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import 'dotenv/config';
import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { Repo } from './models/Repo.js';

const { PORT = 4000, MONGODB_URI, JWT_SECRET } = process.env;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set to a random value of at least 32 characters');
  process.exit(1);
}

try {
  await connectDatabase(MONGODB_URI);
  await Repo.updateMany(
    { status: 'indexing' },
    { $set: { status: 'failed', errorMessage: 'Indexing was interrupted. Delete and add it again.' } }
  );
  createApp().listen(PORT, () => console.log(`RepoMentor API listening on port ${PORT}`));
} catch (error) {
  console.error('Could not start the API:', error.message);
  process.exit(1);
}
