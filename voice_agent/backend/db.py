"""
MySQL persistence for voice sessions, call turns, and session events.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import aiomysql

logger = logging.getLogger("db")

_pool: aiomysql.Pool | None = None

DEFAULT_GREETING = "Hello! How can I help you today?"


@dataclass
class VoiceSession:
    context: str
    example: str
    end_points: list[str]
    greeting: str | None
    graph: dict[str, Any]
    created_at: float

    def resolve_greeting(self) -> str:
        if self.greeting and self.greeting.strip():
            return self.greeting.strip()
        return DEFAULT_GREETING


def _database_url() -> str | None:
    return os.environ.get("DATABASE_URL")


async def init_pool() -> None:
    global _pool
    url = _database_url()
    if not url:
        logger.warning("[DB] DATABASE_URL not set — using in-memory sessions only")
        return

    # mysql://user:pass@host:port/db
    if not url.startswith("mysql://"):
        raise ValueError("DATABASE_URL must start with mysql://")

    rest = url[len("mysql://") :]
    userinfo, hostpart = rest.split("@", 1)
    user, password = userinfo.split(":", 1)
    host_port, database = hostpart.split("/", 1)
    if ":" in host_port:
        host, port = host_port.split(":", 1)
        port = int(port)
    else:
        host, port = host_port, 3306

    _pool = await aiomysql.create_pool(
        host=host,
        port=port,
        user=user,
        password=password,
        db=database,
        autocommit=True,
        minsize=1,
        maxsize=5,
        charset="utf8mb4",
    )
    logger.info("[DB] MySQL pool ready")


async def close_pool() -> None:
    global _pool
    if _pool:
        _pool.close()
        await _pool.wait_closed()
        _pool = None


def pool_available() -> bool:
    return _pool is not None


async def get_session(session_id: str) -> VoiceSession | None:
    if not _pool:
        return None

    async with _pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                """
                SELECT context, example, end_points, greeting, graph, expires_at, status
                FROM voice_sessions
                WHERE id = %s
                """,
                (session_id,),
            )
            row = await cur.fetchone()

    if not row:
        return None

    if row["status"] == "expired":
        return None

    expires_at = row["expires_at"]
    if isinstance(expires_at, datetime):
        if expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
            await mark_session_expired(session_id)
            return None

    end_points = row["end_points"]
    if isinstance(end_points, str):
        end_points = json.loads(end_points)

    graph = row["graph"]
    if isinstance(graph, str):
        graph = json.loads(graph)

    return VoiceSession(
        context=row["context"] or "",
        example=row["example"] or "",
        end_points=end_points or [],
        greeting=row["greeting"],
        graph=graph or {},
        created_at=datetime.now(timezone.utc).timestamp(),
    )


async def mark_session_started(session_id: str) -> None:
    if not _pool:
        return
    async with _pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE voice_sessions SET started_at = NOW(3) WHERE id = %s AND started_at IS NULL",
                (session_id,),
            )


async def mark_session_completed(session_id: str) -> None:
    if not _pool:
        return
    async with _pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE voice_sessions
                SET status = 'completed', ended_at = NOW(3)
                WHERE id = %s
                """,
                (session_id,),
            )


async def mark_session_expired(session_id: str) -> None:
    if not _pool:
        return
    async with _pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE voice_sessions SET status = 'expired' WHERE id = %s",
                (session_id,),
            )


async def get_next_turn_index(session_id: str) -> int:
    if not _pool:
        return 1
    async with _pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT COALESCE(MAX(turn_index), 0) + 1 FROM call_turns WHERE session_id = %s",
                (session_id,),
            )
            row = await cur.fetchone()
            return int(row[0]) if row else 1


async def insert_call_turn(
    session_id: str,
    turn_index: int,
    speaker: str,
    content: str,
    *,
    node_id: str | None = None,
    is_complete: bool = True,
    completion_status: str = "complete",
    metadata: dict | None = None,
) -> None:
    if not _pool or not content.strip():
        return

    meta_json = json.dumps(metadata) if metadata else None
    async with _pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO call_turns
                  (session_id, turn_index, speaker, node_id, content,
                   is_complete, completion_status, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    session_id,
                    turn_index,
                    speaker,
                    node_id,
                    content,
                    is_complete,
                    completion_status,
                    meta_json,
                ),
            )


async def insert_session_event(
    session_id: str,
    event_type: str,
    *,
    node_id: str | None = None,
    payload: dict | None = None,
) -> None:
    if not _pool:
        return

    payload_json = json.dumps(payload) if payload else None
    async with _pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO session_events (session_id, event_type, node_id, payload)
                VALUES (%s, %s, %s, %s)
                """,
                (session_id, event_type, node_id, payload_json),
            )
