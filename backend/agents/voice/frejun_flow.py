"""FreJun flow URL handler and call_id → sessionId registry."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any
from urllib.parse import urlencode

from fastapi import HTTPException, Request
from pydantic import BaseModel
from teler import CallFlow

from frejun_inbound import resolve_inbound_session_id

logger = logging.getLogger("frejun_flow")

_REGISTRY_TTL_SEC = 3600
_call_registry: dict[str, tuple[str, float]] = {}


class FlowRequestBody(BaseModel):
    call_id: str
    account_id: str | None = None
    from_number: str | None = None
    to_number: str | None = None
    direction: str | None = None

    model_config = {"extra": "ignore"}


def _public_base_url() -> str:
    base = os.environ.get("FREJUN_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base:
        raise ValueError("FREJUN_PUBLIC_BASE_URL must be set for FreJun telephony")
    return base


def _public_ws_base() -> str:
    base = _public_base_url()
    if base.startswith("https://"):
        return "wss://" + base[len("https://") :]
    if base.startswith("http://"):
        return "ws://" + base[len("http://") :]
    return "wss://" + base


def frejun_stream_chunk_ms() -> int:
    return int(os.environ.get("FREJUN_STREAM_CHUNK_MS", "800"))


def frejun_stream_sample_rate_khz() -> str:
    """Teler stream rate — must match CallFlow.stream and FreJunTransport."""
    raw = os.environ.get("FREJUN_STREAM_SAMPLE_RATE", "16k").strip().lower()
    if raw in ("8k", "8000", "8"):
        return "8k"
    return "16k"


def frejun_stream_sample_rate_hz() -> int:
    return 8000 if frejun_stream_sample_rate_khz() == "8k" else 16000


def register_call_session(call_id: str, session_id: str) -> None:
    _purge_registry()
    _call_registry[call_id] = (session_id, time.time())


def lookup_call_session(call_id: str) -> str | None:
    _purge_registry()
    entry = _call_registry.get(call_id)
    return entry[0] if entry else None


def _purge_registry() -> None:
    now = time.time()
    expired = [k for k, (_, ts) in _call_registry.items() if now - ts > _REGISTRY_TTL_SEC]
    for k in expired:
        del _call_registry[k]


def verify_webhook_signature(request: Request, body: bytes) -> None:
    secret = os.environ.get("FREJUN_WEBHOOK_SECRET", "").strip()
    if not secret:
        return

    signature = request.headers.get("X-Teler-Signature") or request.headers.get(
        "X-Frejun-Signature"
    )
    if not signature:
        raise HTTPException(status_code=401, detail="Missing webhook signature")

    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")


def _session_id_from_flow_url(request: Request) -> str | None:
    session_id = request.query_params.get("sessionId") or request.query_params.get("session_id")
    return session_id


def build_stream_flow(session_id: str) -> dict[str, Any]:
    ws_url = f"{_public_ws_base()}/frejun/media-stream?{urlencode({'sessionId': session_id})}"
    sample_rate = frejun_stream_sample_rate_khz()
    chunk_size = frejun_stream_chunk_ms()
    logger.info(
        f"[FREJUN FLOW] stream config sample_rate={sample_rate} chunk_size={chunk_size}ms"
    )
    return CallFlow.stream(
        ws_url=ws_url,
        chunk_size=chunk_size,
        sample_rate=sample_rate,
        record=False,
    )


async def handle_flow_request(request: Request, payload: FlowRequestBody) -> dict[str, Any]:
    session_id = _session_id_from_flow_url(request)

    if not session_id:
        session_id = lookup_call_session(payload.call_id)

    direction = (payload.direction or "").lower()
    if not session_id and direction in ("inbound", "incoming"):
        session_id = await resolve_inbound_session_id(payload.to_number or "")

    if not session_id:
        logger.error(
            f"[FREJUN FLOW] No sessionId for call_id={payload.call_id} direction={direction}"
        )
        return {"action": "hangup"}

    register_call_session(payload.call_id, session_id)
    logger.info(
        f"[FREJUN FLOW] call_id={payload.call_id} session={session_id} direction={direction}"
    )
    return build_stream_flow(session_id)
