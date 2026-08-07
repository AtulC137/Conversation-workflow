"""
Voice session store — MySQL when DATABASE_URL is set, else in-memory fallback.
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import db as db_module

TTL_SECONDS = int(__import__("os").environ.get("SESSION_TTL_SECONDS", "3600"))

DEFAULT_GREETING = "Hello! How can I help you today?"


@dataclass
class VoiceSession:
    context: str
    example: str
    end_points: list[str] = field(default_factory=list)
    greeting: str | None = None
    graph: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)

    def resolve_greeting(self) -> str:
        if self.greeting and self.greeting.strip():
            return self.greeting.strip()
        return DEFAULT_GREETING


_store: dict[str, VoiceSession] = {}


def _purge_expired() -> None:
    now = time.time()
    expired = [sid for sid, s in _store.items() if now - s.created_at > TTL_SECONDS]
    for sid in expired:
        del _store[sid]


def create_session(data: dict[str, Any], session_id: str | None = None) -> str:
    """
  When session_id is provided (Node backend pre-created row), only register in-memory
  if MySQL is unavailable. Otherwise MySQL is the source of truth.
  """
    if session_id and db_module.pool_available():
        return session_id

    _purge_expired()
    sid = session_id or str(uuid.uuid4())
    _store[sid] = VoiceSession(
        context=data.get("context", ""),
        example=data.get("example", ""),
        end_points=data.get("endPoints") or data.get("end_points") or [],
        greeting=data.get("greeting"),
        graph=data.get("graph") or {},
    )
    return sid


async def get_session_async(session_id: str) -> VoiceSession | None:
    if db_module.pool_available():
        session = await db_module.get_session(session_id)
        if session:
            return session

    _purge_expired()
    session = _store.get(session_id)
    if session is None:
        return None
    if time.time() - session.created_at > TTL_SECONDS:
        del _store[session_id]
        return None
    return session


def get_session(session_id: str) -> VoiceSession | None:
    """Sync wrapper for legacy callers — prefers in-memory; use get_session_async in async code."""
    _purge_expired()
    session = _store.get(session_id)
    if session is None:
        return None
    if time.time() - session.created_at > TTL_SECONDS:
        del _store[session_id]
        return None
    return session
