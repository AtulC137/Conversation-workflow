"""Abstract transport for call audio and control events."""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from call_session import CallSession


class CallTransport(ABC):
    """Bridges call audio I/O and optional UI events to CallSession."""

    def __init__(self) -> None:
        self.audio_queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        self.stop_event: asyncio.Event = asyncio.Event()
        # Phone transports ack TTS completion locally; browser waits for client message.
        self.auto_playback_ack: bool = False
        # Sample rate the transport expects for outbound TTS PCM. Telephony
        # transports that run natively at 8 kHz override this.
        self.output_sample_rate: int = 16000

    @abstractmethod
    async def send_event(self, payload: dict) -> None:
        """Send a JSON-serializable event to the client (no-op for phone-only transports)."""

    @abstractmethod
    async def send_pcm(self, chunk: bytes) -> None:
        """Stream PCM audio to the caller."""

    async def clear_output(self) -> None:
        """Drop any buffered outbound audio (override in paced transports)."""
        return None

    async def wait_drained(self) -> None:
        """Block until buffered outbound audio has finished playing.

        No-op for transports that hand audio off immediately; paced transports
        override this so the caller mic is not reopened while the AI is still
        audibly speaking (prevents self-echo barge-in).
        """
        return None

    @abstractmethod
    async def close_connection(self) -> None:
        """Close the underlying connection when the session ends."""

    @abstractmethod
    async def run_receive_loop(self, session: CallSession) -> None:
        """Block until the call ends; forward inbound audio/control to the session."""
