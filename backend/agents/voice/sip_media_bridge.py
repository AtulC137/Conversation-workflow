"""
sip_media_bridge.py — TCP AudioSocket server for Asterisk SIP trunk calls.

Run: python sip_media_bridge.py
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

import db as db_module
from call_session import CallSession
from sessions import get_session_async
from transports.audiosocket import TYPE_UUID, AudioSocketTransport

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("sip_media_bridge")


def _uuid_bytes_to_session_id(uuid_bytes: bytes) -> str:
    """Convert 16-byte AudioSocket UUID to canonical session UUID string."""
    hex_str = uuid_bytes.hex()
    if len(hex_str) != 32:
        return hex_str
    return f"{hex_str[:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:]}"


async def _read_uuid_handshake(reader: asyncio.StreamReader) -> str | None:
    """Read first AudioSocket UUID message from Asterisk."""
    import struct

    header = await reader.readexactly(3)
    msg_type, length = struct.unpack(">BH", header)
    if msg_type != TYPE_UUID or length != 16:
        logger.error(f"[SIP BRIDGE] Expected UUID message, got type={msg_type} len={length}")
        return None
    uuid_bytes = await reader.readexactly(16)
    return _uuid_bytes_to_session_id(uuid_bytes)


async def _handle_connection(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    peer = writer.get_extra_info("peername")
    logger.info(f"[SIP BRIDGE] Connection from {peer}")

    try:
        session_id = await _read_uuid_handshake(reader)
        if not session_id:
            writer.close()
            await writer.wait_closed()
            return

        voice_session = await get_session_async(session_id)
        if voice_session is None:
            logger.error(f"[SIP BRIDGE] Session not found: {session_id}")
            writer.close()
            await writer.wait_closed()
            return

        logger.info(f"[SIP BRIDGE] Starting CallSession for {session_id}")
        transport = AudioSocketTransport(reader, writer)
        session = CallSession(
            session_id,
            voice_session,
            transport,
            connect_event="sip_connected",
        )
        await session.run()
    except Exception as e:
        logger.error(f"[SIP BRIDGE] Connection error: {e}")
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def main() -> None:
    host = os.environ.get("SIP_AUDIOSOCKET_HOST", "0.0.0.0")
    port = int(os.environ.get("SIP_AUDIOSOCKET_PORT", "9092"))

    await db_module.init_pool()

    server = await asyncio.start_server(_handle_connection, host, port)
    addrs = ", ".join(str(sock.getsockname()) for sock in server.sockets or [])
    logger.info(f"[SIP BRIDGE] AudioSocket listening on {addrs}")

    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
