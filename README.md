# Conversation Workflow Platform

Unified stack for designing conversation workflows (flow-ai), persisting them in MySQL (backend), and testing with a real-time voice agent (voice_agent).

## Prerequisites

- Docker and Docker Compose
- Sarvam API key in [`voice_agent/.env`](voice_agent/.env):

```env
SARVAM_API_KEY=your_key_here
```

## Run the full stack

From this directory:

```bash
docker compose up --build
```

| Service | URL |
|---|---|
| flow-ai (workflow builder) | http://localhost:8080 |
| backend API (Node.js) | http://localhost:3001/health |
| Adminer (database UI) | http://localhost:8081 |
| voice UI (test calls) | http://localhost:3000 |
| voice API (health) | http://localhost:8000/health |
| MySQL | localhost:3306 |

### Adminer login

- System: **MySQL**
- Server: **mysql**
- Username: **app**
- Password: **app_secret**
- Database: **conversation_workflow**

### Prisma Studio (optional, local dev)

```bash
cd backend
npm install
npx prisma studio
```

Opens http://localhost:5555

## First-time use

1. Open http://localhost:8080 — you will be redirected to **Register**
2. Create an account and sign in
3. Build a workflow: **Start** → **Conversation** → **End**
4. Enable **Voice**, add **Context** if using Q&A blocks
5. Click **Test Workflow** — voice UI opens in a new tab
6. Browse saved data in Adminer (`workflows`, `voice_sessions`, `call_turns`)

## Architecture

```
flow-ai (:8080)  ──REST──►  backend (:3001)  ──►  MySQL (:3306)
       │                         │
       │                         └──► voice-backend POST /sessions
       │
voice-frontend (:3000) ──WebSocket──► voice-backend (:8000) ──► MySQL (call logs)
```

- **backend**: auth, workflow CRUD, voice session creation, Prisma migrations
- **flow-ai**: React builder; auto-saves workflows to MySQL via backend API
- **voice-backend**: real-time STT/LLM/TTS; reads sessions from MySQL; logs `call_turns` per call

## API endpoints (backend :3001)

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Sign in |
| POST | `/api/auth/refresh` | Refresh access token (cookie) |
| POST | `/api/auth/logout` | Sign out |
| GET | `/api/auth/me` | Current user |
| GET/POST | `/api/workflows` | List / create workflows |
| GET/PUT/DELETE | `/api/workflows/:id` | Read / update / archive |
| POST | `/api/workflows/:id/publish` | Publish version snapshot |
| POST | `/api/voice-sessions` | Start voice test session |
| GET | `/api/voice-sessions/:id/transcript` | Call transcript |

## Standalone development

```bash
# flow-ai only (requires backend + MySQL for persistence)
cd flow-ai && docker compose up --build

# voice_agent only
cd voice_agent && docker compose up --build

# backend only
cd backend && cp .env.example .env && npm install && npm run dev
```

For local flow-ai without Docker, set in `.env`:

```env
VOICE_BACKEND_URL=http://localhost:8000
VITE_VOICE_UI_URL=http://localhost:3000
VITE_API_URL=http://localhost:3001
```

## Notes

- Workflows are stored per user in MySQL (`workflows` table, nodes/edges as JSON)
- Voice sessions expire after 1 hour; cleanup job runs hourly in backend
- Interrupted AI responses save **partial** text in `call_turns` with `completion_status = interrupted`
- The browser connects to `localhost:8000` for WebSocket audio (not the Docker internal hostname)
