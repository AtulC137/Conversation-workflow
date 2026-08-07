"""Pipecat frame processors bridging TelecmiTransport to CallSession audio queues."""

from __future__ import annotations

import asyncio
import logging

from piopiy.frames.frames import AudioRawFrame, Frame, StartFrame, TTSAudioRawFrame
from piopiy.processors.frame_processor import FrameDirection, FrameProcessor

logger = logging.getLogger("piopiy_bridge")


class PiopiyInputBridge(FrameProcessor):
    """Forward inbound telephony PCM into the CallSession STT audio queue."""

    def __init__(self, audio_queue: asyncio.Queue, **kwargs):
        super().__init__(**kwargs)
        self._audio_queue = audio_queue

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, AudioRawFrame):
            try:
                self._audio_queue.put_nowait(frame.audio)
            except asyncio.QueueFull:
                try:
                    self._audio_queue.get_nowait()
                    self._audio_queue.put_nowait(frame.audio)
                except Exception:
                    pass
            return

        await self.push_frame(frame, direction)


class PiopiyOutputBridge(FrameProcessor):
    """Inject outbound PCM from CallSession TTS into the telephony pipeline."""

    def __init__(self, pcm_queue: asyncio.Queue, sample_rate: int = 16000, **kwargs):
        super().__init__(**kwargs)
        self._pcm_queue = pcm_queue
        self._sample_rate = sample_rate
        self._pump_task: asyncio.Task | None = None
        self._started = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame) and not self._started:
            self._started = True
            self._pump_task = asyncio.create_task(self._pump_pcm())

        await self.push_frame(frame, direction)

    async def _pump_pcm(self):
        try:
            while True:
                chunk = await self._pcm_queue.get()
                if chunk is None:
                    break
                await self.push_frame(
                    TTSAudioRawFrame(
                        audio=chunk,
                        sample_rate=self._sample_rate,
                        num_channels=1,
                    )
                )
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"[PIOPIY OUTPUT] pump error: {e}")

    async def cleanup(self):
        await self._pcm_queue.put(None)
        if self._pump_task and not self._pump_task.done():
            self._pump_task.cancel()
            try:
                await self._pump_task
            except asyncio.CancelledError:
                pass
        await super().cleanup()
