"""
Persists call turns and session events with interrupt-aware partial AI responses.
"""

from __future__ import annotations

import logging
from typing import Any

import db as db_module

logger = logging.getLogger("call_logger")


class CallLogger:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self._ai_buffer = ""
        self._ai_node_id: str | None = None
        self._ai_metadata: dict[str, Any] | None = None

    async def _insert_turn(
        self,
        speaker: str,
        content: str,
        *,
        node_id: str | None = None,
        is_complete: bool = True,
        completion_status: str = "complete",
        metadata: dict | None = None,
    ) -> None:
        await db_module.insert_call_turn_allocating(
            self.session_id,
            speaker,
            content,
            node_id=node_id,
            is_complete=is_complete,
            completion_status=completion_status,
            metadata=metadata,
        )

    async def log_event(
        self,
        event_type: str,
        *,
        node_id: str | None = None,
        payload: dict | None = None,
    ) -> None:
        try:
            await db_module.insert_session_event(
                self.session_id, event_type, node_id=node_id, payload=payload
            )
        except Exception as e:
            logger.error(f"[CALL_LOG] event error: {e}")

    async def start_ai_turn(self, node_id: str | None = None, metadata: dict | None = None) -> None:
        await self.flush_ai_interrupted()
        self._ai_buffer = ""
        self._ai_node_id = node_id
        self._ai_metadata = metadata

    def append_ai_token(self, token: str) -> None:
        self._ai_buffer += token

    async def complete_ai_turn(self, full_text: str | None = None) -> None:
        text = (full_text or self._ai_buffer).strip()
        self._ai_buffer = ""
        if not text:
            return
        try:
            await self._insert_turn(
                "assistant",
                text,
                node_id=self._ai_node_id,
                is_complete=True,
                completion_status="complete",
                metadata=self._ai_metadata,
            )
        except Exception as e:
            logger.error(f"[CALL_LOG] complete_ai error: {e}")
            raise
        self._ai_node_id = None
        self._ai_metadata = None

    async def flush_ai_interrupted(self, full_generated: str | None = None) -> None:
        text = self._ai_buffer.strip()
        if not text:
            self._ai_buffer = ""
            return
        meta = dict(self._ai_metadata or {})
        if full_generated and full_generated.strip() != text:
            meta["fullGeneratedText"] = full_generated.strip()
        meta["interruptedBy"] = "caller_speech"
        try:
            await self._insert_turn(
                "assistant",
                text,
                node_id=self._ai_node_id,
                is_complete=False,
                completion_status="interrupted",
                metadata=meta or None,
            )
            await self.log_event("interrupted", node_id=self._ai_node_id, payload=meta)
        except Exception as e:
            logger.error(f"[CALL_LOG] interrupt flush error: {e}")
            raise
        self._ai_buffer = ""
        self._ai_node_id = None
        self._ai_metadata = None

    async def log_caller(self, transcript: str, *, node_id: str | None = None, metadata: dict | None = None) -> None:
        text = transcript.strip()
        if not text:
            return
        try:
            await self._insert_turn(
                "caller",
                text,
                node_id=node_id,
                is_complete=True,
                completion_status="complete",
                metadata=metadata,
            )
        except Exception as e:
            logger.error(f"[CALL_LOG] caller error: {e}")
            raise

    async def log_system(self, content: str, *, node_id: str | None = None, metadata: dict | None = None) -> None:
        text = content.strip()
        if not text:
            return
        try:
            await self._insert_turn(
                "system",
                text,
                node_id=node_id,
                is_complete=True,
                completion_status="complete",
                metadata=metadata,
            )
        except Exception as e:
            logger.error(f"[CALL_LOG] system error: {e}")
            raise
