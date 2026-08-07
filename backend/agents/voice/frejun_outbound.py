"""FreJun outbound call trigger."""

from __future__ import annotations

import os
from urllib.parse import urlencode

from pydantic import BaseModel
from teler import AsyncClient

from frejun_flow import register_call_session
from phone_utils import normalize_phone_number


class OutboundCallBody(BaseModel):
    sessionId: str
    phoneNumber: str


def _public_base_url() -> str:
    base = os.environ.get("FREJUN_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base:
        raise ValueError("FREJUN_PUBLIC_BASE_URL must be set for FreJun telephony")
    return base


async def trigger_outbound_call(session_id: str, phone_number: str) -> dict:
    api_key = os.environ.get("TELER_API_KEY", "").strip()
    from_number = os.environ.get("FREJUN_FROM_NUMBER", "").strip()

    if not api_key or not from_number:
        raise ValueError("TELER_API_KEY and FREJUN_FROM_NUMBER must be set")

    to_number = normalize_phone_number(phone_number)
    from_e164 = normalize_phone_number(from_number)

    base = _public_base_url()
    flow_url = f"{base}/frejun/flow?{urlencode({'sessionId': session_id})}"
    status_callback = (
        os.environ.get("FREJUN_STATUS_CALLBACK_URL", "").strip()
        or f"{base}/frejun/webhook"
    )

    async with AsyncClient(api_key=api_key, timeout=15) as client:
        call = await client.calls.create(
            from_number=from_e164,
            to_number=to_number,
            flow_url=flow_url,
            status_callback_url=status_callback,
            record=False,
        )

    call_id = getattr(call, "id", None) or (call.data.get("id") if hasattr(call, "data") else None)
    if call_id:
        register_call_session(str(call_id), session_id)

    return {
        "status": "calling",
        "sessionId": session_id,
        "callId": call_id,
    }
