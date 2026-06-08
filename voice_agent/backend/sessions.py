"""
In-memory voice session store for workflow-driven prompts.
Sessions expire after TTL_SECONDS (default 1 hour).
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

TTL_SECONDS = 3600

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


def create_session(data: dict[str, Any]) -> str:
    _purge_expired()
    session_id = str(uuid.uuid4())
    _store[session_id] = VoiceSession(
        context=data.get("context", ""),
        example=data.get("example", ""),
        end_points=data.get("endPoints") or data.get("end_points") or [],
        greeting=data.get("greeting"),
        graph=data.get("graph") or {},
    )
    return session_id


def get_session(session_id: str) -> VoiceSession | None:
    _purge_expired()
    session = _store.get(session_id)
    if session is None:
        return None
    if time.time() - session.created_at > TTL_SECONDS:
        del _store[session_id]
        return None
    return session
