"""PIOPIY telephony transport using TelecmiTransport + CallSession audio bridge."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from piopiy.pipeline.pipeline import Pipeline
from piopiy.pipeline.runner import PipelineRunner
from piopiy.pipeline.task import PipelineParams, PipelineTask
from piopiy.transports.services.telecmi import TelecmiParams, TelecmiTransport

from transports.base import CallTransport
from transports.piopiy_bridge import PiopiyInputBridge, PiopiyOutputBridge

if TYPE_CHECKING:
    from call_session import CallSession

logger = logging.getLogger("piopiy_transport")


class PiopiyTransport(CallTransport):
    def __init__(self) -> None:
        super().__init__()
        self.auto_playback_ack = True
        self._pcm_out_queue: asyncio.Queue = asyncio.Queue(maxsize=400)
        self._telecmi: TelecmiTransport | None = None
        self._pipeline_task: asyncio.Task | None = None

    async def send_event(self, payload: dict) -> None:
        logger.debug(f"[PIOPIY EVENT] {payload.get('type')}")

    async def send_pcm(self, chunk: bytes) -> None:
        try:
            self._pcm_out_queue.put_nowait(chunk)
        except asyncio.QueueFull:
            try:
                self._pcm_out_queue.get_nowait()
                self._pcm_out_queue.put_nowait(chunk)
            except Exception:
                pass

    async def close_connection(self) -> None:
        self.stop_event.set()

    async def run_receive_loop(self, session: CallSession) -> None:
        telecmi = TelecmiTransport(
            params=TelecmiParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                audio_in_sample_rate=16000,
                audio_out_sample_rate=16000,
            )
        )
        self._telecmi = telecmi

        input_bridge = PiopiyInputBridge(self.audio_queue)
        output_bridge = PiopiyOutputBridge(self._pcm_out_queue, sample_rate=16000)

        pipeline = Pipeline(
            [
                telecmi.input(),
                input_bridge,
                output_bridge,
                telecmi.output(),
            ]
        )
        task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
        runner = PipelineRunner(handle_sigint=False)

        @telecmi.event_handler("on_participant_disconnected")
        async def _participant_left(_transport, _participant):
            logger.info("[PIOPIY] Participant disconnected")
            self.stop_event.set()

        @telecmi.event_handler("on_disconnected")
        async def _disconnected(_transport):
            logger.info("[PIOPIY] Transport disconnected")
            self.stop_event.set()

        self._pipeline_task = asyncio.create_task(runner.run(task))

        try:
            await self.stop_event.wait()
        finally:
            try:
                await task.cancel()
            except Exception:
                pass
            await output_bridge.cleanup()
            if self._pipeline_task and not self._pipeline_task.done():
                self._pipeline_task.cancel()
                try:
                    await self._pipeline_task
                except asyncio.CancelledError:
                    pass
