# RepoMentor

RepoMentor is an AI question-and-answer tool for GitHub repositories. It retrieves relevant code chunks from MongoDB Atlas Vector Search, then asks Gemini to answer from those snippets with file and line citations.

## Current features

- React + Vite client with account registration and sign-in.
- Express API with JWT authentication and MongoDB-backed users.
- Add a GitHub repository, skip paths listed in its root `.repomentorignore`, and split supported source files into line-numbered chunks. JavaScript, TypeScript/TSX, and Python use AST-aware chunks by default; other files use line-based chunks.
- Save a compact overview from the repository README, package metadata, and root folders so broad project questions have useful context.
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

2. Copy `server/.env.example` to `server/.env`. Set `MONGODB_URI` and `JWT_SECRET` (use a random secret with at least 32 characters). Set `GEMINI_API_KEY` to your Gemini API key. `GITHUB_TOKEN` is optional and only needed for private repositories or additional GitHub API quota. Copy `client/.env.example` to `client/.env` only if you need to set `VITE_API_URL`; an empty value uses the Vite `/api` proxy during development.

3. Set `LLM_PROVIDER=gemini` and choose a required `LLM_MODEL` in `server/.env` (for example, `gemini-2.5-flash`). Configure the other values as needed:

   ```env
   LLM_PROVIDER=gemini
   LLM_MODEL=gemini-2.5-flash
   CHUNKING_MODE=ast
   ```

   `gemini` is currently the only supported provider. `LLM_MODEL` is required and selects the Gemini generation model. `CHUNKING_MODE` accepts `ast` (the default) or `lines`. Add one ignore pattern per line to a repository's root `.repomentorignore`; lines starting with `#` are comments.

## Environment variables

| Variable | Required | Purpose | Default or example |
| --- | --- | --- | --- |
| `PORT` | No | API server port | `4000` |
| `NODE_ENV` | No | Runtime environment; production enables the production CORS policy | `development` locally; `production` when deployed |
| `MONGODB_URI` | Yes | MongoDB Atlas connection string | Set in `server/.env` |
| `JWT_SECRET` | Yes | Signs and verifies login tokens | Random secret, at least 32 characters |
| `JWT_EXPIRES_IN` | No | Login token lifetime | `1d` |
| `CORS_ORIGIN` | Required in production | Comma-separated browser origins allowed to call the API | `http://localhost:5173` locally |
| `VITE_API_URL` | No | API base URL baked into the client build | Empty for the local `/api` development proxy |
| `REGISTRATION_OPEN` | No | Enables account registration | `true`; set `false` to close registration |
| `GLOBAL_DAILY_ASK_LIMIT` | No | Maximum answer-model calls across the whole server per UTC day | `200` |
| `MAX_CHUNKS_PER_REPO` | No | Maximum indexed chunks allowed per repository | `400` |
| `GITHUB_TOKEN` | No | GitHub API access and higher rate limits | Empty; public repositories work without it |
| `GEMINI_API_KEY` | Needed for embeddings and answers | Authenticates requests to Gemini | Set your key in `server/.env` |
| `LLM_PROVIDER` | Yes for answers | Selects the answer provider | `gemini` |
| `LLM_MODEL` | Yes for answers | Selects the Gemini answer model | No default; set a model name |
| `LLM_FALLBACK_MODEL` | No | Optional model tried once after the main model exhausts retries on a quota or server error, before any streamed text is sent | Empty disables fallback |
| `RETRIEVAL_MIN_SCORE` | No | Minimum similarity score before generating an answer | `0.78` |
| `CHUNKING_MODE` | No | Selects AST-aware or line-based chunks | `ast` |
| `ASK_RATE_LIMIT_PER_HOUR` | No | Ask requests allowed per user each hour | `20` |

`RETRIEVAL_MIN_SCORE` defaults to `0.78` if it is missing, empty, or invalid. Adjust it using the retrieval scores printed in development. `ASK_RATE_LIMIT_PER_HOUR` defaults to `20` questions per user per hour. `GLOBAL_DAILY_ASK_LIMIT` defaults to `200` answer-model calls per UTC day across all users. The server stores this counter in MongoDB so it survives restarts. In production, both `CORS_ORIGIN` and `JWT_SECRET` must be set.

## How streaming works

The client sends the question to `POST /api/repos/:id/ask/stream` with `fetch` and reads the response as it arrives. The server retrieves code first, sends the source list, then forwards answer text as token events. When generation finishes, the server cleans citations, saves the complete message, and sends a `done` event. The Stop button aborts that request; an interrupted answer stays visible as an unsaved partial answer.

## Chunking modes

The evaluation script in `server/scripts/eval.js` uses the same retrieval function for either chunking mode. Run it after indexing a repository in the chosen mode to compare retrieval quality.

| Mode | How files are split | Symbol details | When to use it |
| --- | --- | --- | --- |
| `lines` | Every file uses roughly 60-line chunks | None | Simple baseline and comparison |
| `ast` | JavaScript, TypeScript/TSX, and Python split around code structures; Markdown splits by headings; unsupported or invalid syntax falls back to line chunks | Adds symbol and kind when the parser recognizes code | Default for code-aware citations |

## Deployment

Set the server variables in the hosting provider's secret/environment settings. At minimum, production needs `NODE_ENV=production`, `PORT`, `MONGODB_URI`, a 32-character-or-longer `JWT_SECRET`, and a comma-separated `CORS_ORIGIN` containing the exact deployed client origins. Configure `GEMINI_API_KEY` and `LLM_MODEL` to enable indexing and answers. `VITE_API_URL` is a client build-time setting pointing to the server base URL; it is not read by the running server. Keep secrets out of source control.

| Component | Build command | Start / publish |
| --- | --- | --- |
| Server on Node | `npm ci --omit=dev` | `npm start --workspace server` |
| Client | `npm ci` then `npm run build --workspace client` (set `VITE_API_URL` before building) | Publish the generated `client/dist` directory with a static host |
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
