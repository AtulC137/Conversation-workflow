"""
piopiy_agent.py — long-running PIOPIY agent for phone-based workflow tests.

Run: python piopiy_agent.py
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

import db as db_module
from call_session import CallSession
from piopiy.agent import Agent
from sessions import get_session_async
from transports.piopiy import PiopiyTransport

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("piopiy_agent")


def _session_id_from_metadata(metadata: dict | None) -> str | None:
    if not metadata:
        return None
    if isinstance(metadata, str):
        return metadata
    return metadata.get("sessionId") or metadata.get("session_id")


async def create_session(
    agent_id: str,
    call_id: str,
    from_number: str,
    to_number: str,
    metadata: dict | None = None,
    **kwargs,
):
    session_id = _session_id_from_metadata(metadata)
    if not session_id:
        logger.error(f"[PIOPIY] No sessionId in metadata for call {call_id}")
        return

    voice_session = await get_session_async(session_id)
    if voice_session is None:
        logger.error(f"[PIOPIY] Session not found: {session_id}")
        return

    logger.info(
        f"[PIOPIY CALL] call_id={call_id} from={from_number} to={to_number} "
        f"session={session_id}"
    )

    transport = PiopiyTransport()
    session = CallSession(
        session_id,
        voice_session,
        transport,
        connect_event="piopiy_connected",
    )
    await session.run()


async def main():
    agent_id = os.environ.get("PIOPIY_AGENT_ID", "")
    agent_token = os.environ.get("PIOPIY_AGENT_TOKEN", "")

    if not agent_id or not agent_token:
        logger.error("PIOPIY_AGENT_ID and PIOPIY_AGENT_TOKEN are required")
        sys.exit(1)

    await db_module.init_pool()

    agent = Agent(
        agent_id=agent_id,
        agent_token=agent_token,
        create_session=create_session,
        debug=os.environ.get("PIOPIY_DEBUG", "").lower() in ("1", "true", "yes"),
    )

    logger.info("PIOPIY agent online. Waiting for calls...")
    await agent.connect()


if __name__ == "__main__":
    asyncio.run(main())
