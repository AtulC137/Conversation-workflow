"""PIOPIY outbound AI call trigger."""

from __future__ import annotations

import os
import re

from pydantic import BaseModel

_E164_RE = re.compile(r"^\+?[1-9]\d{6,14}$")


def normalize_phone_number(phone: str) -> str:
    """Strip + for PIOPIY API (digits only, E.164 without plus)."""
    cleaned = phone.strip().replace(" ", "").replace("-", "")
    if not _E164_RE.match(cleaned):
        raise ValueError("Phone number must be E.164 format, e.g. +919876543210")
    return cleaned.lstrip("+")


class OutboundCallBody(BaseModel):
    sessionId: str
    phoneNumber: str


async def trigger_outbound_call(session_id: str, phone_number: str) -> dict:
    agent_id = os.environ.get("PIOPIY_AGENT_ID", "")
    agent_token = os.environ.get("PIOPIY_AGENT_TOKEN", "")
    caller_id = os.environ.get("PIOPIY_CALLER_ID", "")

    if not agent_id or not agent_token or not caller_id:
        raise ValueError(
            "PIOPIY_AGENT_ID, PIOPIY_AGENT_TOKEN, and PIOPIY_CALLER_ID must be set"
        )

    to_number = normalize_phone_number(phone_number)
    from_number = normalize_phone_number(caller_id)

    from piopiy import RestClient

    client = RestClient(agent_token)
    response = client.ai.call(
        caller_id=from_number,
        to_number=to_number,
        agent_id=agent_id,
        variables={"sessionId": session_id},
    )
    return {"status": "calling", "sessionId": session_id, "response": response}
