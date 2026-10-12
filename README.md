# RepoMentor — Phase 1

RepoMentor is being built in phases. This phase provides a React login/register page and an Express API with MongoDB-backed users and JWT authentication. RAG, GitHub ingestion, background jobs, and code search are intentionally not part of this phase.

## Requirements

- Node.js 20 or newer
- A MongoDB Atlas database (or local MongoDB)

## Setup

1. Install dependencies from the repository root: `npm install`.
2. Copy `server/.env.example` to `server/.env` and set `MONGODB_URI` and a long random `JWT_SECRET`.
3. Start both apps with `npm run dev`.
4. Visit `http://localhost:5173`, register an account, then sign in.

The API listens on `http://localhost:4000`. `GET /api/health` checks that the server is running and MongoDB is connected. Auth routes are `POST /api/auth/register` and `POST /api/auth/login`.

For production, set the same environment variables in your hosting provider and run `npm run build` followed by `npm start`. Use HTTPS and keep `.env` out of source control.
