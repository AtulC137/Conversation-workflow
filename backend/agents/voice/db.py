"""
MySQL persistence for voice sessions, call turns, and session events.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from workflow_config import (
    build_example_script,
    collect_end_points,
    find_greeting,
    react_flow_to_voice_graph,
)

import aiomysql
import pymysql.err

logger = logging.getLogger("db")

_pool: aiomysql.Pool | None = None
_MAX_TURN_INSERT_RETRIES = 5

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


async def _raw_insert_call_turn(
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
    if not _pool:
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


async def insert_call_turn_allocating(
    session_id: str,
    speaker: str,
    content: str,
    *,
    node_id: str | None = None,
    is_complete: bool = True,
    completion_status: str = "complete",
    metadata: dict | None = None,
) -> int:
    if not _pool or not content.strip():
        return 0

    last_err: pymysql.err.IntegrityError | None = None
    for _ in range(_MAX_TURN_INSERT_RETRIES):
        turn_index = await get_next_turn_index(session_id)
        try:
            await _raw_insert_call_turn(
                session_id,
                turn_index,
                speaker,
                content,
                node_id=node_id,
                is_complete=is_complete,
                completion_status=completion_status,
                metadata=metadata,
            )
            return turn_index
        except pymysql.err.IntegrityError as e:
            if e.args[0] == 1062:
                last_err = e
                continue
            raise

    raise RuntimeError(
        f"Failed to insert call turn after {_MAX_TURN_INSERT_RETRIES} attempts "
        f"for session {session_id}"
    ) from last_err


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
    """Insert with a caller-supplied turn index. Prefer insert_call_turn_allocating."""
    if not content.strip():
        return
    await _raw_insert_call_turn(
        session_id,
        turn_index,
        speaker,
        content,
        node_id=node_id,
        is_complete=is_complete,
        completion_status=completion_status,
        metadata=metadata,
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


def _parse_json_field(value: Any) -> Any:
    if isinstance(value, str):
        return json.loads(value)
    return value


async def load_published_workflow(workflow_id: str) -> dict[str, Any] | None:
    """Load workflow config from live row or latest published version snapshot."""
    if not _pool:
        return None

    async with _pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                """
                SELECT id, context, nodes, edges
                FROM workflows
                WHERE id = %s
                """,
                (workflow_id,),
            )
            wf = await cur.fetchone()
            if not wf:
                return None

            await cur.execute(
                """
                SELECT id, snapshot
                FROM workflow_versions
                WHERE workflow_id = %s
                ORDER BY version_number DESC
                LIMIT 1
                """,
                (workflow_id,),
            )
            version = await cur.fetchone()

    nodes = _parse_json_field(wf["nodes"]) or []
    edges = _parse_json_field(wf["edges"]) or []
    context = wf["context"] or ""
    version_id = None

    if version:
        version_id = version["id"]
        snapshot = _parse_json_field(version["snapshot"]) or {}
        if snapshot.get("nodes"):
            nodes = snapshot["nodes"]
        if snapshot.get("edges"):
            edges = snapshot["edges"]
        if snapshot.get("context"):
            context = snapshot["context"]

    graph = react_flow_to_voice_graph(nodes, edges)
    return {
        "workflow_id": workflow_id,
        "workflow_version_id": version_id,
        "context": context,
        "example": build_example_script(nodes, edges),
        "end_points": collect_end_points(nodes),
        "greeting": find_greeting(nodes, edges),
        "graph": graph,
    }


async def create_inbound_voice_session(
    *,
    user_id: str,
    workflow_id: str,
    workflow_version_id: str | None = None,
) -> str:
    if not _pool:
        raise RuntimeError("DATABASE_URL required for inbound voice sessions")

    config = await load_published_workflow(workflow_id)
    if not config:
        raise ValueError(f"Workflow not found: {workflow_id}")

    session_id = str(uuid.uuid4())
    ttl = int(os.environ.get("SESSION_TTL_SECONDS", "3600"))
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl)
    version_id = workflow_version_id or config.get("workflow_version_id")

    async with _pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO voice_sessions
                  (id, user_id, workflow_id, workflow_version_id,
                   context, example, end_points, greeting, graph,
                   status, expires_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'active', %s)
                """,
                (
                    session_id,
                    user_id,
                    workflow_id,
                    version_id,
                    config["context"],
                    config["example"],
                    json.dumps(config["end_points"]),
                    config["greeting"],
                    json.dumps(config["graph"]),
                    expires_at.replace(tzinfo=None),
                ),
            )

    return session_id
