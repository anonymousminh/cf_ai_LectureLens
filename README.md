# LectureLens

An AI-powered study assistant that helps students understand their lecture materials. Upload lecture PDFs or text files, get instant summaries, extract key concepts, and chat with an AI tutor grounded in your lecture content.

**Live:** Deployed on Cloudflare Workers + Pages
**Link:** https://lectrurelens.pages.dev

---

## Features

- **Upload Lectures** — Upload PDF or TXT files (up to 50 MB). Content is extracted, stored, and indexed per user.
- **AI Summarization** — Generate structured, Markdown-formatted summaries. Long documents are automatically chunked, summarized in parts, and merged into a cohesive overview.
- **Concept Extraction** — Extract key definitions, formulas, and core theoretical concepts from any lecture.
- **Contextual Chat** — Ask questions in plain English and get answers grounded in your uploaded lecture content, powered by a persistent chat history.
- **Authentication** — Email/password signup with PBKDF2 hashing, plus Google Sign-In (OAuth). Session-based auth with Bearer tokens.
- **Rate Limiting** — Per-user and per-IP rate limiting via Durable Objects to prevent abuse.
- **Lecture Management** — View, select, and delete your uploaded lectures from a sidebar.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Vanilla HTML/CSS/JS, served via Cloudflare Pages |
| **Backend** | Cloudflare Workers (TypeScript) |
| **AI Model** | Cloudflare Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| **Database** | Cloudflare D1 (SQLite) — users, sessions, user-lecture mappings |
| **Stateful Storage** | Cloudflare Durable Objects — lecture content & chat history (`LectureMemory`), rate limits (`RateLimiter`) |
| **Auth** | PBKDF2 password hashing + Google Identity Services |
| **PDF Parsing** | PDF.js (client-side extraction) |

---

## Project Structure

```
LectureLens/
├── frontend/                   # Cloudflare Pages frontend
│   ├── index.html              # Landing page, auth forms, main app UI
│   ├── style.css               # Styling
│   ├── script.js               # Client-side logic (auth, upload, chat, sidebar)
│   └── functions/api/          # Pages Functions (proxy to Worker backend)
│       ├── [[path]].js         # Catch-all proxy for /api/*
│       └── auth/
│           ├── login.js
│           └── signup.js
├── worker-backend/             # Cloudflare Worker backend
│   ├── src/
│   │   ├── index.ts            # Main Worker entry — all API route handlers
│   │   ├── auth.ts             # Password hashing (PBKDF2) & session validation
│   │   ├── LectureMemory.ts    # Durable Object for lecture storage & chat
│   │   └── RateLimiter.ts      # Durable Object for per-endpoint rate limiting
│   ├── migrations/
│   │   ├── 0001_add_lecture_metadata.sql
│   │   └── 0002_add_google_auth.sql
│   ├── wrangler.jsonc          # Wrangler config (bindings, D1, DOs, AI)
│   └── package.json
├── schema.sql                  # Base database schema (users, user_lectures, sessions)
└── README.md
```

---

## API Endpoints

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/signup` | Register with email + password |
| `POST` | `/api/auth/login` | Login with email + password |
| `POST` | `/api/auth/google` | Sign in / sign up with Google |
| `POST` | `/api/auth/logout` | Invalidate the current session |

### Lectures

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/upload` | Upload a lecture file (multipart/form-data) |
| `GET` | `/api/my-lectures` | List all lectures for the authenticated user |
| `DELETE` | `/api/lectures/:id` | Delete a lecture |

### AI Features

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat/:lectureId` | Send a chat message about a specific lecture |
| `POST` | `/api/summarize` | Summarize lecture text |
| `POST` | `/api/extract-concepts` | Extract key concepts from a lecture |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/stats` | Public aggregate stats (user count, lecture count) |
| `GET` | `/` | Health check |

All authenticated endpoints require an `Authorization: Bearer <token>` header.

---

## Database Schema

**`users`** — User accounts (email/password or Google OAuth)

**`sessions`** — Auth session tokens with expiration

**`user_lectures`** — Maps users to their uploaded lectures (with name and timestamp)

---

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| Chat | 15 requests | per minute |
| Summarize | 5 requests | per hour |
| Extract Concepts | 5 requests | per hour |
| Upload | 10 requests | per hour |
| Signup | 3 requests | per hour (per IP) |
| Login | 10 requests | per hour (per IP) |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A Cloudflare account with Workers, D1, Durable Objects, and Workers AI enabled

### Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/<your-username>/LectureLens.git
   cd LectureLens
   ```

2. **Install backend dependencies**

   ```bash
   cd worker-backend
   npm install
   ```

3. **Create the D1 database**

   ```bash
   wrangler d1 create lecturelens_db
   ```

   Update the `database_id` in `worker-backend/wrangler.jsonc` with the ID returned.

4. **Run database migrations**

   ```bash
   wrangler d1 execute lecturelens_db --file=../schema.sql
   wrangler d1 execute lecturelens_db --file=migrations/0001_add_lecture_metadata.sql
   wrangler d1 execute lecturelens_db --file=migrations/0002_add_google_auth.sql
   ```

5. **Set secrets** (for Google OAuth)

   The Google Client ID is already configured in `wrangler.jsonc`. If using your own Google OAuth credentials, update the `GOOGLE_CLIENT_ID` var.

6. **Run the backend locally**

   ```bash
   npm run dev
   ```

7. **Serve the frontend**

   In a separate terminal, from the project root:

   ```bash
   cd frontend
   npx wrangler pages dev . --port 8788
   ```

---

## Deployment

### Backend (Worker)

```bash
cd worker-backend
npm run deploy
```

### Frontend (Pages)

Deploy the `frontend/` directory to Cloudflare Pages via the dashboard or CLI. The Pages Functions in `frontend/functions/` proxy `/api/*` requests to the Worker backend.

---

## License

This project is for educational purposes.
