"""Asterisk AudioSocket transport for SIP trunk phone calls."""

from __future__ import annotations

import asyncio
import audioop
import logging
import struct
from typing import TYPE_CHECKING

from transports.base import CallTransport

if TYPE_CHECKING:
    from call_session import CallSession

logger = logging.getLogger("audiosocket_transport")

# Asterisk AudioSocket protocol message types
TYPE_HANGUP = 0x00
TYPE_UUID = 0x01
TYPE_DTMF = 0x03
TYPE_AUDIO = 0x10

ASTERISK_RATE = 8000
CALL_SESSION_RATE = 16000
BYTES_PER_SAMPLE = 2
PTIME_MS = 20
# 20ms @ 8kHz on the AudioSocket wire (TTS now produces native 8kHz PCM)
OUTBOUND_FRAME_BYTES_8K = ASTERISK_RATE * BYTES_PER_SAMPLE * PTIME_MS // 1000
READ_CHUNK = OUTBOUND_FRAME_BYTES_8K  # 20ms at 8kHz
FRAME_INTERVAL_S = PTIME_MS / 1000.0


class AudioSocketTransport(CallTransport):
    """Bridges Asterisk AudioSocket TCP stream to CallSession audio queues."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        super().__init__()
        self.auto_playback_ack = True
        # TTS renders natively at 8 kHz for telephony; no outbound resampling.
        self.output_sample_rate = ASTERISK_RATE
        self._reader = reader
        self._writer = writer
        self._playback_buffer_8k = bytearray()
        self._outbound_lock = asyncio.Lock()
        self._player_task: asyncio.Task | None = None
        self._resample_state_in: tuple | None = None

    async def send_event(self, payload: dict) -> None:
        logger.debug(f"[AUDIOSOCKET EVENT] {payload.get('type')}")

    def _to_stt_pcm(self, pcm_8k: bytes) -> bytes:
        converted, self._resample_state_in = audioop.ratecv(
            pcm_8k, BYTES_PER_SAMPLE, 1, ASTERISK_RATE, CALL_SESSION_RATE, self._resample_state_in
        )
        return converted

    async def _send_frame(self, msg_type: int, payload: bytes) -> None:
        header = struct.pack(">BH", msg_type, len(payload))
        self._writer.write(header + payload)
        await self._writer.drain()

    def _ensure_player(self) -> None:
        if self._player_task is None or self._player_task.done():
            self._player_task = asyncio.create_task(self._player_loop())

    async def _player_loop(self) -> None:
        """Drain the 8kHz playback buffer at a steady 20ms cadence."""
        loop = asyncio.get_event_loop()
        next_send = loop.time()
        try:
            while not self.stop_event.is_set():
                async with self._outbound_lock:
                    if len(self._playback_buffer_8k) >= OUTBOUND_FRAME_BYTES_8K:
                        frame = bytes(self._playback_buffer_8k[:OUTBOUND_FRAME_BYTES_8K])
                        del self._playback_buffer_8k[:OUTBOUND_FRAME_BYTES_8K]
                    else:
                        frame = None

                if frame is None:
                    # Nothing to play; rebase the schedule so we don't burst
                    # a backlog of frames once audio resumes.
                    await asyncio.sleep(FRAME_INTERVAL_S)
                    next_send = loop.time()
                    continue

                try:
                    await self._send_frame(TYPE_AUDIO, frame)
                except Exception as e:
                    logger.error(f"[AUDIOSOCKET OUTPUT] send error: {e}")
                    self.stop_event.set()
                    break

                next_send += FRAME_INTERVAL_S
                delay = next_send - loop.time()
                if delay > 0:
                    await asyncio.sleep(delay)
                else:
                    # Fell behind; reset baseline to avoid catch-up bursts.
                    next_send = loop.time()
        except asyncio.CancelledError:
            pass

    async def send_pcm(self, chunk: bytes) -> None:
        async with self._outbound_lock:
            self._playback_buffer_8k.extend(chunk)
        self._ensure_player()

    async def clear_output(self) -> None:
        async with self._outbound_lock:
            self._playback_buffer_8k.clear()

    async def wait_drained(self) -> None:
        """Return once the playback buffer holds less than a full frame."""
        while not self.stop_event.is_set():
            async with self._outbound_lock:
                remaining = len(self._playback_buffer_8k)
            if remaining < OUTBOUND_FRAME_BYTES_8K:
                return
            await asyncio.sleep(FRAME_INTERVAL_S)

    async def close_connection(self) -> None:
        if self._player_task is not None and not self._player_task.done():
            self._player_task.cancel()
            try:
                await self._player_task
            except asyncio.CancelledError:
                pass
            self._player_task = None
        try:
            async with self._outbound_lock:
                remaining = bytes(self._playback_buffer_8k)
                self._playback_buffer_8k.clear()
            if remaining:
                pad = (-len(remaining)) % OUTBOUND_FRAME_BYTES_8K
                if pad:
                    remaining += b"\x00" * pad
                await self._send_frame(TYPE_AUDIO, remaining)
            await self._send_frame(TYPE_HANGUP, b"")
        except Exception:
            pass
        try:
            self._writer.close()
            await self._writer.wait_closed()
        except Exception:
            pass

    async def _read_message(self) -> tuple[int, bytes] | None:
        header = await self._reader.readexactly(3)
        msg_type, length = struct.unpack(">BH", header)
        payload = b""
        if length:
            payload = await self._reader.readexactly(length)
        return msg_type, payload

    async def run_receive_loop(self, session: CallSession) -> None:
        del session
        try:
            while not self.stop_event.is_set():
                try:
                    msg_type, payload = await asyncio.wait_for(self._read_message(), timeout=30.0)
                except asyncio.TimeoutError:
                    continue
                except asyncio.IncompleteReadError:
                    break

                if msg_type == TYPE_HANGUP:
                    logger.info("[AUDIOSOCKET] Hangup received")
                    self.stop_event.set()
                    break
                if msg_type == TYPE_UUID:
                    logger.info(f"[AUDIOSOCKET] UUID handshake: {payload.hex()}")
                    continue
                if msg_type == TYPE_DTMF:
                    logger.debug(f"[AUDIOSOCKET] DTMF: {payload}")
                    continue
                if msg_type == TYPE_AUDIO:
                    pcm_16k = self._to_stt_pcm(payload)
                    try:
                        self.audio_queue.put_nowait(pcm_16k)
                    except asyncio.QueueFull:
                        try:
                            self.audio_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                        self.audio_queue.put_nowait(pcm_16k)
                    continue

                logger.warning(f"[AUDIOSOCKET] Unknown message type: {msg_type}")
        except Exception as e:
            logger.error(f"[AUDIOSOCKET] receive loop error: {e}")
            self.stop_event.set()
