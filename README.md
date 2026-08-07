# Conversation Workflow Platform

Unified stack for designing conversation workflows (flow-ai), persisting them in MySQL (backend), and testing with a real-time voice agent (`backend/agents/voice`).

## Prerequisites

- Docker and Docker Compose
- Copy [`backend/agents/voice/.env.example`](backend/agents/voice/.env.example) to `backend/agents/voice/.env` and set:
  - `SARVAM_API_KEY` — Sarvam STT/LLM/TTS
  - **Phone tests** — set `TELEPHONY_PROVIDER` to `piopiy`, `frejun`, or `sip`:
    - **PIOPIY**: `PIOPIY_AGENT_ID`, `PIOPIY_AGENT_TOKEN`, `PIOPIY_CALLER_ID` ([PIOPIY dashboard](https://doc.piopiy.com/piopiy/docs/getting-started/introduction))
    - **FreJun HTTP API**: `TELER_API_KEY`, `FREJUN_FROM_NUMBER`, `FREJUN_PUBLIC_BASE_URL` (public HTTPS; use ngrok for local dev). Optional `FREJUN_INBOUND_DID_MAP` for inbound PSTN.
    - **FreJun SIP trunk** (recommended when API outbound is forbidden): `SIP_TRUNK_*`, `ASTERISK_AMI_*` — see [SIP trunk phone tests](#sip-trunk-phone-tests-frejun) below.

## Run the stack

### Option A — full stack from repo root

```bash
docker compose up --build
```

### Option B — backend stack only

```bash
cd backend
npm run docker:up
```

Starts MySQL, Adminer, backend API, voice-backend, sip-media-bridge, and Asterisk.

### Option C — flow-ai only (requires backend stack running)

```bash
cd flow-ai
npm run docker:up
```

Start the backend stack first so the shared `conversation-net` Docker network exists.

| Service | URL |
|---|---|
| flow-ai (workflow builder + voice mic UI) | http://localhost:8080 |
| backend API (Node.js) | http://localhost:3001/health |
| Adminer (database UI) | http://localhost:8081 |
| voice API (health) | http://localhost:8000/health |
| piopiy-agent (PIOPIY rollback) | `cd backend && npm run docker:up:piopiy` |
| asterisk + sip-media-bridge (SIP trunk) | included in `cd backend && npm run docker:up` |
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
2. Create an organization and admin account, then sign in with **organization slug** + email + password
3. Build a workflow: **Start** → **Conversation** → **End**
4. Enable **Voice**, add **Context** if using Q&A blocks
5. Click **Test Workflow** — choose **Call my phone** (SIP trunk, FreJun API, or PIOPIY) or **Test in browser** (mic UI)
6. Browse saved data in Adminer (`workflows`, `voice_sessions`, `call_turns`)

## Architecture

```
flow-ai (:8080)  ──REST──►  backend (:3001)  ──►  MySQL (:3306)
       │                         │
       │                         ├──► voice-backend POST /sessions
       │                         └──► voice-backend POST /sip/outbound-call (or /frejun/… /piopiy/…)
       │
       └── /voice-mic-ui.html ──WebSocket──► voice-backend (:8000) or backend /voice/ws/audio (proxy mode)

Phone PSTN ──► FreJun SIP trunk ──► Asterisk ──AudioSocket──► sip-media-bridge ──► CallSession
(FreJun HTTP API: WSS /frejun/media-stream on voice-backend when TELEPHONY_PROVIDER=frejun)
(piopiy-agent profile: PIOPIY signaling when TELEPHONY_PROVIDER=piopiy)
```

- **backend**: auth, workflow CRUD, voice session creation, telephony outbound trigger (`TELEPHONY_PROVIDER`), optional `/voice/*` gateway
- **flow-ai**: React builder + browser mic test UI (`/voice-mic-ui.html`); auto-saves workflows to MySQL via backend API
- **voice-backend** (`backend/agents/voice`): browser WebSocket + FreJun media stream + outbound API; STT/LLM/TTS via Sarvam
- **piopiy-agent** (optional profile): PIOPIY rollback when `TELEPHONY_PROVIDER=piopiy`
- **asterisk + sip-media-bridge**: FreJun SIP trunk when `TELEPHONY_PROVIDER=sip`
- **voice mic UI**: [`flow-ai/public/voice-mic-ui.html`](flow-ai/public/voice-mic-ui.html) + [`pcm-processor.js`](flow-ai/public/pcm-processor.js)
- **whatsapp-agent** (`backend/agents/whatsapp`): placeholder for future sub-backend

## Browser DevTools — what to expect

| Step | Network tab |
|---|---|
| Open **Test Voice** modal | No requests (UI only) |
| Click **Test in browser** or **Call my phone** | POST to flow-ai (TanStack server function), not directly to `:3001` |
| Mic UI tab loads | HTML + `pcm-processor.js` |
| Click **Start** in mic UI | WebSocket — use **WS** or **All** filter (not Fetch/XHR only) |

**Local dev** (`VITE_VOICE_WS_MODE=direct`): WebSocket connects to `ws://localhost:8000/ws/audio`.

**Deploy / proxy mode** (`VITE_VOICE_WS_MODE=proxy` + `USE_WS_PROXY=1` on backend): WebSocket connects to `ws://localhost:3001/voice/ws/audio`.

## API endpoints (backend :3001)

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Create organization + admin account |
| POST | `/api/auth/login` | Sign in (organization slug + email + password) |
| GET | `/api/auth/check-slug/:slug` | Check org slug availability |
| GET | `/api/org` | Organization info |
| GET | `/api/org/members` | List org members (dashboard) |
| POST | `/api/org/members` | Invite member |
| PATCH | `/api/org/members/:id` | Update role/permissions |
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
# Backend stack (Docker)
cd backend && npm run docker:up

# flow-ai (Docker, after backend)
cd flow-ai && npm run docker:up

# Backend without Docker
cd backend && cp .env.example .env && npm install && npm run dev
```

For local flow-ai without Docker, set in `flow-ai/.env`:

```env
VOICE_BACKEND_URL=http://localhost:8000
VITE_API_URL=http://localhost:3001
VITE_VOICE_WS_MODE=direct
```

Browser mic test opens at `http://localhost:8080/voice-mic-ui.html?session=<id>`.

For production behind a single public host, set `VITE_VOICE_WS_MODE=proxy` on flow-ai and `USE_WS_PROXY=1` on backend.

## Notes

- **Database volume**: MySQL data is stored in Docker volume `conversationworkflow_mysql_data`. Compose pins this name so data survives split-stack deploys (`cd backend` vs repo root). Do not run `docker compose down -v` unless you intend to wipe the database.
- Workflows are stored per user in MySQL (`workflows` table, nodes/edges as JSON)
- Voice sessions expire after 1 hour; cleanup job runs hourly in backend
- Interrupted AI responses save **partial** text in `call_turns` with `completion_status = interrupted`
- **Local dev**: browser connects to `localhost:8000` for WebSocket audio (direct mode)
- **Phone tests (FreJun HTTP API)**: set `TELEPHONY_PROVIDER=frejun`, `FREJUN_PUBLIC_BASE_URL` to a public HTTPS URL (ngrok/Cloudflare tunnel for local dev). Teler POSTs to `/frejun/flow` and streams audio to `/frejun/media-stream`.
- **Phone tests (FreJun SIP trunk)**: set `TELEPHONY_PROVIDER=sip`, configure trunk credentials in `backend/agents/voice/.env`, run `npm run docker:up`. No ngrok required for outbound. See below.
- **Phone tests (PIOPIY rollback)**: `TELEPHONY_PROVIDER=piopiy` and run `piopiy-agent` profile; agent must reach `signaling.piopiy.com`.
- Phone numbers use E.164 format (e.g. `+919876543210`)

## SIP trunk phone tests (FreJun)

Use this when your FreJun account has **SIP trunk** access but HTTP API `calls.create` returns `Forbidden`.

### 1. FreJun dashboard

1. Create a SIP trunk at [platform.frejun.ai/app/sip-trunks](https://platform.frejun.ai/app/sip-trunks)
2. Set **Credential Authentication** (username + password)
3. Copy the trunk **domain name** (Termination URL) → `SIP_TRUNK_DOMAIN`
4. Ensure your virtual number is authorized as outbound caller ID → `SIP_TRUNK_CALLER_ID`
5. For **inbound**: set **Origination URL** to `sip:<your-public-host>:5060` (or `:5061` if trunk Secure/TLS is enabled)

### 2. Configure `.env`

Copy [`backend/agents/voice/.env.example`](backend/agents/voice/.env.example) and set:

```env
TELEPHONY_PROVIDER=sip
SIP_TRUNK_DOMAIN=your-trunk-domain
SIP_TRUNK_USERNAME=teler
SIP_TRUNK_PASSWORD=your-password
SIP_TRUNK_CALLER_ID=+918065179582
ASTERISK_AMI_USER=voiceagent
ASTERISK_AMI_SECRET=changeme
```

Also set `TELEPHONY_PROVIDER=sip` in `backend/.env`.

### 3. Run backend stack

```bash
cd backend
npm run docker:up
```

This starts the full stack including `asterisk` and `sip-media-bridge`.

### 4. Test

1. Start flow-ai (`cd flow-ai && npm run docker:up`)
2. Open workflow → **Test Workflow** → **Call my phone**
3. For inbound: call your FreJun number; map DID in `SIP_INBOUND_DID_MAP`:

```json
{"+918065179582":{"workflowId":"<uuid>","userId":"<uuid>"}}
```

### Windows / local dev caveats

| Feature | Local Windows + Docker |
|---|---|
| Outbound phone test | Usually works (credential auth to FreJun) |
| Inbound PSTN | Requires public SIP reachability on port 5060/5061 — HTTP ngrok does **not** work for SIP. Use a cloud VM with a static IP or port-forward SIP/RTP to your host. |

### Test checklist

- [ ] `curl http://localhost:8000/health` → `telephonyProvider: sip`
- [ ] `docker ps` shows `voice-asterisk` and `sip-media-bridge` running
- [ ] `docker exec voice-asterisk asterisk -rx "pjsip show endpoints"` → lists `frejun-trunk`
- [ ] Outbound: workflow phone test rings your mobile and plays greeting
- [ ] Inbound: PSTN call to mapped DID creates session and AI answers
