"""FreJun/Teler media-stream transport for phone calls (teler-py protocol)."""



from __future__ import annotations



import asyncio

import audioop

import base64

import json

import logging

from typing import TYPE_CHECKING



from fastapi import WebSocket, WebSocketDisconnect



from frejun_flow import frejun_stream_chunk_ms, frejun_stream_sample_rate_hz
from transports.base import CallTransport



if TYPE_CHECKING:

    from call_session import CallSession



logger = logging.getLogger("frejun_transport")



SAMPLE_RATE = 16000

BYTES_PER_SAMPLE = 2

DEFAULT_OUTBOUND_MS = frejun_stream_chunk_ms()

OUTBOUND_MIN_BYTES = int(SAMPLE_RATE * BYTES_PER_SAMPLE * DEFAULT_OUTBOUND_MS / 1000)





class FreJunTransport(CallTransport):

    """Bridges Teler bidirectional media WebSocket to CallSession audio queues.



    Message format follows frejun-tech/teler-py StreamConnector examples:

    - inbound:  {"type": "audio", "data": {"audio_b64": "..."}}

    - outbound: {"type": "audio", "audio_b64": "...", "chunk_id": N}

    - clear:    {"type": "clear"} on barge-in / interruption

    """



    def __init__(self, websocket: WebSocket) -> None:

        super().__init__()

        self.auto_playback_ack = True

        self._websocket = websocket

        self._outbound_buffer = bytearray()

        self._outbound_lock = asyncio.Lock()

        self._chunk_id = 0

        self._stream_sample_rate = frejun_stream_sample_rate_hz()



    async def send_event(self, payload: dict) -> None:

        if payload.get("type") == "interrupted":

            await self._send_clear()



    async def _send_clear(self) -> None:

        try:

            await self._websocket.send_text(json.dumps({"type": "clear"}))

        except Exception as e:

            logger.error(f"[FREJUN OUTPUT] clear error: {e}")

            self.stop_event.set()



    async def _send_teler_audio(self, pcm: bytes) -> None:

        self._chunk_id += 1

        message = {

            "type": "audio",

            "audio_b64": base64.b64encode(pcm).decode("ascii"),

            "chunk_id": self._chunk_id,

        }

        try:

            await self._websocket.send_text(json.dumps(message))

        except Exception as e:

            logger.error(f"[FREJUN OUTPUT] send error: {e}")

            self.stop_event.set()



    async def _flush_outbound(self, force: bool = False) -> None:

        async with self._outbound_lock:

            if not self._outbound_buffer:

                return

            if not force and len(self._outbound_buffer) < OUTBOUND_MIN_BYTES:

                return

            chunk = bytes(self._outbound_buffer)

            self._outbound_buffer.clear()



        if self._stream_sample_rate != SAMPLE_RATE:

            chunk, _ = audioop.ratecv(

                chunk, BYTES_PER_SAMPLE, 1, SAMPLE_RATE, self._stream_sample_rate, None

            )

        await self._send_teler_audio(chunk)



    async def send_pcm(self, chunk: bytes) -> None:

        if self.stop_event.is_set():

            return

        async with self._outbound_lock:

            self._outbound_buffer.extend(chunk)

        await self._flush_outbound(force=False)



    async def close_connection(self) -> None:

        await self._flush_outbound(force=True)

        self.stop_event.set()

        try:

            await self._websocket.close()

        except Exception:

            pass



    def _decode_inbound_b64(self, b64: str) -> bytes:

        raw = base64.b64decode(b64)

        if self._stream_sample_rate != SAMPLE_RATE and raw:

            raw, _ = audioop.ratecv(

                raw, BYTES_PER_SAMPLE, 1, self._stream_sample_rate, SAMPLE_RATE, None

            )

        return raw



    def _enqueue_pcm(self, pcm: bytes) -> None:

        try:

            self.audio_queue.put_nowait(pcm)

        except asyncio.QueueFull:

            try:

                self.audio_queue.get_nowait()

                self.audio_queue.put_nowait(pcm)

            except Exception:

                pass



    def _handle_teler_audio(self, payload: dict) -> None:

        data = payload.get("data") or {}

        b64 = data.get("audio_b64") or payload.get("audio_b64")

        if not b64:

            return

        try:

            pcm = self._decode_inbound_b64(b64)

            self._enqueue_pcm(pcm)

        except Exception as e:

            logger.error(f"[FREJUN INPUT] decode error: {e}")



    async def run_receive_loop(self, session: CallSession) -> None:

        del session  # CallSession drives STT; transport only moves audio.

        try:

            while not self.stop_event.is_set():

                message = await self._websocket.receive()

                if message.get("type") == "websocket.disconnect":

                    logger.info("[FREJUN] WebSocket disconnected")

                    break



                text = message.get("text")

                if not text:

                    continue



                try:

                    payload = json.loads(text)

                except json.JSONDecodeError:

                    logger.debug("[FREJUN] Non-JSON frame ignored")

                    continue



                msg_type = payload.get("type")

                if msg_type == "audio":

                    self._handle_teler_audio(payload)

                elif msg_type in ("connected", "start"):

                    rate = payload.get("sample_rate") or payload.get("sampleRate")

                    if rate:

                        try:

                            parsed = str(rate).lower().replace("k", "000")

                            self._stream_sample_rate = int(parsed)

                        except ValueError:

                            pass

                    logger.info(f"[FREJUN] Stream {msg_type} rate={self._stream_sample_rate}")

                elif msg_type in ("stop", "closed", "end"):

                    logger.info(f"[FREJUN] Stream {msg_type} received")

                    break

                else:

                    logger.debug(f"[FREJUN] Ignored message type={msg_type}")

        except WebSocketDisconnect:

            logger.info("[FREJUN] Client disconnected")

        except Exception as e:

            logger.error(f"[FREJUN] receive error: {e}")

        finally:

            self.stop_event.set()

            await self._flush_outbound(force=True)


