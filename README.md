# RepoMentor

RepoMentor is an AI question-and-answer tool for GitHub repositories. It retrieves relevant code chunks from MongoDB Atlas Vector Search, then asks Gemini to answer from those snippets with file and line citations.

## Current features

- React + Vite client with account registration and sign-in.
- Express API with JWT authentication and MongoDB-backed users.
- Add a GitHub repository, skip paths listed in its root `.repomentorignore`, and split supported source files into line-numbered chunks. JavaScript, TypeScript/TSX, and Python use AST-aware chunks by default; other files use line-based chunks.
- Embed code and questions with Gemini, then search chunks with MongoDB Atlas Vector Search.
- Ask questions about a ready repository, see plain-text answers with clickable citations, and review the latest 20 saved questions and answers.
- Repository ownership checks, request validation, rate limits, and safe public error messages.

## Requirements

- Node.js 20 or newer
- MongoDB Atlas (Vector Search is required for repository search and questions)
- A Gemini API key for embedding and answer generation
- Optional GitHub token for indexing private repositories or using your GitHub API quota

## Setup

1. From the repository root, install dependencies:

   ```sh
   npm install
   ```

2. Copy `server/.env.example` to `server/.env`. Set `MONGODB_URI` and `JWT_SECRET` (use a random secret with at least 32 characters). Set `GEMINI_API_KEY` to your Gemini API key. `GITHUB_TOKEN` is optional and only needed for private repositories or additional GitHub API quota.

3. Configure the answer model in `server/.env`:

   ```env
   LLM_PROVIDER=gemini
   LLM_MODEL=gemini-2.5-flash
   CHUNKING_MODE=ast
   ```

   `gemini` is currently the only supported provider. `LLM_MODEL` selects the Gemini generation model. `CHUNKING_MODE` accepts `ast` (the default) or `lines`; `lines` uses 60-line chunks for every file without symbol metadata. Add one ignore pattern per line to a repository's root `.repomentorignore`; lines starting with `#` are comments. `RETRIEVAL_MIN_SCORE` defaults to `0.5`; adjust it if development logs show the relevant code is frequently rejected or unrelated code is accepted. `ASK_RATE_LIMIT_PER_HOUR` defaults to `20` questions per user per hour.

4. In MongoDB Atlas, create the `chunk_vector_index` vector search index on the `chunks` collection, using the 768-dimensional `embedding` field with cosine similarity and a `repoId` filter field. The app does not create this index automatically.

5. Start the API and client from the repository root:

   ```sh
   npm run dev
   ```

6. Open `http://localhost:5173`, create an account, add a GitHub repository, wait until its status is `ready`, then use **Ask**.

The API listens on `http://localhost:4000`. `GET /api/health` reports the MongoDB connection state. The main endpoints are `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/repos`, `POST /api/repos/:id/search`, `POST /api/repos/:id/ask`, and `GET /api/repos/:id/messages`.

## Notes

- Keep `server/.env` private and out of source control. Never commit API keys or database credentials.
- The answer service only receives the question and retrieved snippets. If retrieval finds no code above the configured score threshold, the app returns a fixed “couldn't find relevant code” response without calling Gemini.
- Answers are plain text. Citation markers link to the corresponding retrieved source snippets and line ranges.
- For production, set the environment variables in your hosting provider, build the client with `npm run build`, and start the API with `npm start`. Use HTTPS.
