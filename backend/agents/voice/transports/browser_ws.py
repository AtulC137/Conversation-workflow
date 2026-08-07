"""Browser WebSocket transport for mic/speaker voice testing."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING

from fastapi import WebSocket, WebSocketDisconnect

from transports.base import CallTransport

if TYPE_CHECKING:
    from call_session import CallSession

logger = logging.getLogger("browser_ws")


class BrowserWsTransport(CallTransport):
    def __init__(self, websocket: WebSocket) -> None:
        super().__init__()
        self._websocket = websocket

    async def send_event(self, payload: dict) -> None:
        try:
            await self._websocket.send_text(json.dumps(payload))
        except Exception:
            pass

    async def send_pcm(self, chunk: bytes) -> None:
        try:
            await self._websocket.send_bytes(chunk)
        except Exception:
            pass

    async def close_connection(self) -> None:
        try:
            await self._websocket.close()
        except Exception:
            pass

    async def run_receive_loop(self, session: CallSession) -> None:
        try:
            while True:
                message = await self._websocket.receive()

                if "bytes" in message and message["bytes"]:
                    if session.is_closing or not session.caller_listening:
                        continue
                    data = message["bytes"]
                    try:
                        self.audio_queue.put_nowait(data)
                    except asyncio.QueueFull:
                        try:
                            self.audio_queue.get_nowait()
                            self.audio_queue.put_nowait(data)
                        except Exception:
                            pass

                elif "text" in message and message["text"]:
                    try:
                        payload = json.loads(message["text"])
                        if payload.get("type") == "client_interrupt":
                            await session.handle_client_interrupt()
                        elif payload.get("type") == "tts_playback_done":
                            await session.handle_tts_playback_done()
                    except Exception as e:
                        logger.debug(f"[TEXT MSG PARSE ERROR] {e}")

        except WebSocketDisconnect:
            logger.info("[CLIENT DISCONNECTED]")
        except Exception as e:
            logger.error(f"[ERROR] {e}")
