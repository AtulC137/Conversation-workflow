# Conversation Workflow Platform

Unified stack for designing conversation workflows (flow-ai) and testing them with a real-time voice agent (voice_agent).

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
| voice UI (test calls) | http://localhost:3000 |
| voice API (health) | http://localhost:8000/health |

## How to test voice integration

1. Open http://localhost:8080
2. Create a workflow: **Start** → **Conversation** (add an AI message) → optional branches → **End**
3. Enable **Voice** in the header and enter agent intent (e.g. "You are a sales assistant for ACME Corp")
4. Click **Test Workflow** — a new tab opens the voice UI with your session
5. Click **Start** in the voice tab and speak
6. The greeting uses the first conversation node's message
7. The agent follows your workflow context; say goodbye or a branch phrase to end the call

## Architecture

```
flow-ai (:8080)  ──POST /sessions──►  voice-backend (:8000)
                                              ▲
voice-frontend (:3000) ──WebSocket────────────┘
```

- flow-ai converts the workflow graph + voice intent into a session config
- voice-backend stores the session and builds a dynamic system prompt per call
- voice-frontend connects with `?session=<id>` from the Test Workflow link

## Standalone development

Each project can still run independently:

```bash
# flow-ai only
cd flow-ai && docker compose up --build

# voice_agent only
cd voice_agent && docker compose up --build
```

For local flow-ai without Docker, set in `.env`:

```env
VOICE_BACKEND_URL=http://localhost:8000
VITE_VOICE_UI_URL=http://localhost:3000
```

## Notes

- Voice sessions are stored in memory and expire after 1 hour; restarting voice-backend clears them
- The browser connects to `localhost:8000` for WebSocket audio (not the Docker internal hostname)
- WhatsApp testing still uses the in-app text preview modal (voice opens a new tab)
