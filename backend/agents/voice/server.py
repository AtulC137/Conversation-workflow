"""
server.py — FastAPI HTTP/WebSocket entry + telephony outbound triggers.
"""

import logging
import os
import sys

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import db as db_module
import llm as llm_module
import tts as tts_module
from call_session import CallSession
from frejun_flow import FlowRequestBody, handle_flow_request, verify_webhook_signature
from frejun_outbound import OutboundCallBody, trigger_outbound_call as frejun_trigger_outbound
from piopiy_outbound import trigger_outbound_call as piopiy_trigger_outbound
from sip_inbound import resolve_inbound_session_id
from sip_outbound import trigger_outbound_call as sip_trigger_outbound
from sessions import create_session, get_session_async
from transports.browser_ws import BrowserWsTransport
from transports.frejun import FreJunTransport

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("server")

TELEPHONY_PROVIDER = os.environ.get("TELEPHONY_PROVIDER", "piopiy").strip().lower()

app = FastAPI(title="Voice Workflow Assistant")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class SessionCreateBody(BaseModel):
    sessionId: str | None = None
    context: str = ""
    example: str = ""
    endPoints: list[str] = Field(default_factory=list)
    greeting: str | None = None
    graph: dict = Field(default_factory=dict)


def _telephony_provider() -> str:
    if TELEPHONY_PROVIDER in ("piopiy", "frejun", "sip"):
        return TELEPHONY_PROVIDER
    return "piopiy"


@app.on_event("startup")
async def startup():
    await db_module.init_pool()
    if _telephony_provider() == "frejun":
        logger.info("[TELEPHONY] Provider: FreJun/Teler")
    elif _telephony_provider() == "sip":
        logger.info("[TELEPHONY] Provider: SIP trunk (Asterisk)")
    else:
        logger.info("[TELEPHONY] Provider: PIOPIY")


@app.on_event("shutdown")
async def shutdown():
    await llm_module.close()
    await tts_module.close()
    await db_module.close_pool()


@app.get("/health")
async def health():
    return {"status": "ok", "telephonyProvider": _telephony_provider()}


@app.post("/sessions")
async def create_voice_session(body: SessionCreateBody):
    session_id = create_session(body.model_dump(), session_id=body.sessionId)
    logger.info(f"[SESSION CREATED] {session_id}")
    return {"sessionId": session_id}


@app.get("/sessions/{session_id}")
async def get_voice_session(session_id: str):
    session = await get_session_async(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found or expired")
    return {
        "sessionId": session_id,
        "context": session.context,
        "example": session.example,
        "endPoints": session.end_points,
        "greeting": session.greeting,
        "graph": session.graph,
    }


@app.post("/piopiy/outbound-call")
async def piopiy_outbound_call(body: OutboundCallBody):
    try:
        result = await piopiy_trigger_outbound(body.sessionId, body.phoneNumber)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error(f"[PIOPIY OUTBOUND] {e}")
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/frejun/outbound-call")
async def frejun_outbound_call(body: OutboundCallBody):
    try:
        result = await frejun_trigger_outbound(body.sessionId, body.phoneNumber)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error(f"[FREJUN OUTBOUND] {e}")
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/sip/outbound-call")
async def sip_outbound_call(body: OutboundCallBody):
    try:
        result = await sip_trigger_outbound(body.sessionId, body.phoneNumber)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error(f"[SIP OUTBOUND] {e}")
        raise HTTPException(status_code=502, detail=str(e)) from e


class InboundResolveBody(BaseModel):
    toNumber: str


@app.post("/internal/sip/inbound-resolve")
async def sip_inbound_resolve(body: InboundResolveBody):
    session_id = await resolve_inbound_session_id(body.toNumber)
    if not session_id:
        raise HTTPException(status_code=404, detail="Unmapped DID or session bootstrap failed")
    session_uuid = session_id.replace("-", "").lower()
    return {"sessionId": session_id, "sessionUuid": session_uuid}


@app.post("/frejun/webhook")
async def frejun_webhook(request: Request):
    """Teler status callback (see teler-py sample /webhook)."""
    body_bytes = await request.body()
    verify_webhook_signature(request, body_bytes)
    try:
        import json

        data = json.loads(body_bytes.decode() or "{}")
    except Exception:
        data = {}
    logger.info(f"[FREJUN WEBHOOK] {data}")
    return {"status": "received"}


@app.post("/frejun/flow")
async def frejun_flow(request: Request):
    body_bytes = await request.body()
    verify_webhook_signature(request, body_bytes)
    try:
        import json

        data = json.loads(body_bytes.decode() or "{}")
        payload = FlowRequestBody.model_validate(data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid flow payload: {e}") from e

    try:
        return await handle_flow_request(request, payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error(f"[FREJUN FLOW] {e}")
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.websocket("/frejun/media-stream")
async def frejun_media_stream(websocket: WebSocket):
    session_id = websocket.query_params.get("sessionId")
    if not session_id:
        await websocket.close(code=4000, reason="sessionId query param required")
        return

    voice_session = await get_session_async(session_id)
    if voice_session is None:
        await websocket.close(code=4004, reason="Session not found or expired")
        return

    await websocket.accept()
    logger.info(f"[FREJUN CONNECTED] session={session_id}")

    transport = FreJunTransport(websocket)
    session = CallSession(
        session_id,
        voice_session,
        transport,
        connect_event="frejun_connected",
    )
    await session.run()


@app.websocket("/ws/audio")
async def audio_ws(websocket: WebSocket):
    session_id = websocket.query_params.get("sessionId")
    if not session_id:
        await websocket.close(code=4000, reason="sessionId query param required")
        return

    voice_session = await get_session_async(session_id)
    if voice_session is None:
        await websocket.close(code=4004, reason="Session not found or expired")
        return

    await websocket.accept()
    logger.info(f"[CLIENT CONNECTED] session={session_id}")

    transport = BrowserWsTransport(websocket)
    session = CallSession(session_id, voice_session, transport)
    await session.run()
