"""Inbound PSTN call session bootstrap via DID → workflow mapping."""

from __future__ import annotations

import json
import logging
import os
import uuid

import db as db_module

logger = logging.getLogger("frejun_inbound")

SESSION_TTL_SECONDS = int(os.environ.get("SESSION_TTL_SECONDS", "3600"))


def _normalize_did(number: str) -> str:
    cleaned = number.strip().replace(" ", "").replace("-", "")
    if cleaned and not cleaned.startswith("+"):
        return f"+{cleaned.lstrip('+')}"
    return cleaned


def _load_did_map() -> dict[str, dict]:
    raw = os.environ.get("FREJUN_INBOUND_DID_MAP", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.error(f"[FREJUN INBOUND] Invalid FREJUN_INBOUND_DID_MAP: {e}")
        return {}
    if not isinstance(data, dict):
        return {}
    return { _normalize_did(k): v for k, v in data.items() if isinstance(v, dict) }


async def resolve_inbound_session_id(to_number: str) -> str | None:
    did = _normalize_did(to_number)
    entry = _load_did_map().get(did)
    if not entry:
        logger.error(f"[FREJUN INBOUND] Unmapped DID: {did}")
        return None

    workflow_id = entry.get("workflowId") or entry.get("workflow_id")
    if not workflow_id:
        logger.error(f"[FREJUN INBOUND] DID {did} missing workflowId")
        return None

    user_id = (
        entry.get("userId")
        or entry.get("user_id")
        or os.environ.get("FREJUN_INBOUND_SYSTEM_USER_ID", "").strip()
    )
    if not user_id:
        logger.error(f"[FREJUN INBOUND] No userId for DID {did}")
        return None

    workflow_version_id = entry.get("workflowVersionId") or entry.get("workflow_version_id")

    try:
        session_id = await db_module.create_inbound_voice_session(
            user_id=str(user_id),
            workflow_id=str(workflow_id),
            workflow_version_id=str(workflow_version_id) if workflow_version_id else None,
        )
        logger.info(f"[FREJUN INBOUND] Created session {session_id} for DID {did}")
        return session_id
    except Exception as e:
        logger.error(f"[FREJUN INBOUND] Session bootstrap failed: {e}")
        return None
