"""
call_session.py — shared workflow-driven voice call orchestration.
Used by browser WebSocket and telephony transports (PIOPIY / FreJun).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

import db as db_module
import llm as llm_module
from call_logger import CallLogger
from contact_context import parse_contact_fields, patch_graph_placeholders, sanitize_tts_text
from sessions import VoiceSession
from stt import run_streaming_stt
from tts import TtsWsSession
from workflow_runner import NODE_GAP_SEC, WorkflowRunner

if TYPE_CHECKING:
    from transports.base import CallTransport

logger = logging.getLogger("call_session")

def _tts_start_event(sample_rate: int) -> dict:
    return {"type": "tts_start", "format": "pcm_s16le", "sampleRate": sample_rate}


class CallSession:
    def __init__(
        self,
        session_id: str,
        voice_session: VoiceSession,
        transport: CallTransport,
        *,
        connect_event: str = "ws_connected",
    ) -> None:
        self.session_id = session_id
        self.voice_session = voice_session
        self.transport = transport
        self._connect_event = connect_event

        self.call_logger = CallLogger(session_id)
        self.base_context = voice_session.context
        self._contact_fields = parse_contact_fields(self.base_context)
        graph = voice_session.graph
        if self._contact_fields:
            graph = patch_graph_placeholders(graph, self._contact_fields)
        self.workflow_runner = WorkflowRunner(graph)
        self.base_example = voice_session.example
        self.greeting = sanitize_tts_text(
            voice_session.resolve_greeting(), self._contact_fields
        )

        self.conversation_history: list = []
        self._transcript_buffer: list = []
        self._active_tasks: set = set()
        self._turn_cancel: asyncio.Event = asyncio.Event()

        self._speech_ended: bool = False
        self.is_closing: bool = False
        self._greeting_active: bool = True
        self._llm_spawned_this_turn: bool = False

        self._turn_stt_lang: str | None = None
        self._last_lang: str | None = None
        self._current_tts_lang: str = "en-IN"
        self._tts_streaming: bool = False
        self._tts_aborted_for_retry: bool = False

        self._llm_start_at: float | None = None
        self._first_pcm_logged: bool = False
        self._prewarm_task: asyncio.Task | None = None
        self._silence_timer_task: asyncio.Task | None = None
        self.caller_listening: bool = False
        self._pending_react_transcript: str | None = None
        self._pending_react_prior_message: str | None = None
        self._prefetch_task: asyncio.Task | None = None
        self._prefetch_cache: dict[str, str] = {}
        self._playback_done = asyncio.Event()
        self._playback_done.set()

        self.tts_session = TtsWsSession(sample_rate=transport.output_sample_rate)

    @property
    def audio_queue(self) -> asyncio.Queue:
        return self.transport.audio_queue

    @property
    def stop_event(self) -> asyncio.Event:
        return self.transport.stop_event

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._active_tasks.add(task)
        task.add_done_callback(self._active_tasks.discard)
        return task

    def _other_active_tasks(self) -> set:
        exclude = {self._silence_timer_task} if self._silence_timer_task else set()
        return self._active_tasks - exclude

    def _schedule_tts_prewarm(self, lang: str = "en-IN", *, after_abort: bool = False):
        if self._prewarm_task and not self._prewarm_task.done():
            return
        self._prewarm_task = asyncio.create_task(
            self.tts_session.prewarm(lang, after_abort=after_abort)
        )

    async def _cancel_prewarm_task(self):
        if self._prewarm_task and not self._prewarm_task.done():
            self._prewarm_task.cancel()
            try:
                await self._prewarm_task
            except asyncio.CancelledError:
                pass
        self._prewarm_task = None

    async def _await_tts_prewarm(self, lang: str, *, after_abort: bool = False):
        await self._cancel_prewarm_task()
        await self.tts_session.prewarm(lang, after_abort=after_abort)

    def _interrupt(self):
        if self.is_closing:
            return
        self._turn_cancel.set()
        for t in list(self._active_tasks):
            t.cancel()
        self._spawn(self._cancel_silence_advance())

    def _start_new_turn(self):
        self._turn_cancel = asyncio.Event()
        self._speech_ended = False
        self._llm_spawned_this_turn = False
        self._llm_start_at = None
        self._first_pcm_logged = False

    async def _send(self, payload: dict):
        await self.transport.send_event(payload)

    async def _cancel_silence_advance(self):
        if self._silence_timer_task and not self._silence_timer_task.done():
            self._silence_timer_task.cancel()
            try:
                await self._silence_timer_task
            except asyncio.CancelledError:
                pass
        self._silence_timer_task = None

    def _maybe_start_turn(self, transcript: str):
        if (
            self._llm_spawned_this_turn
            or self.is_closing
            or self._greeting_active
            or self._turn_cancel.is_set()
        ):
            return
        self._spawn(self._cancel_silence_advance())
        self._llm_spawned_this_turn = True
        self._speech_ended = False
        logger.info(f"[TURN END] processing: {transcript!r}")
        self._spawn(
            self.call_logger.log_caller(
                transcript,
                node_id=self.workflow_runner.current_node_id,
                metadata={"sttLang": self._turn_stt_lang} if self._turn_stt_lang else None,
            )
        )
        self._spawn(self._run_turn(transcript, self._turn_cancel, self._turn_stt_lang))

    async def _silence_wait_and_advance(self):
        timeout = self.workflow_runner.get_silence_timeout_sec()
        try:
            await asyncio.sleep(timeout)
        except asyncio.CancelledError:
            return
        if self.is_closing or self.stop_event.is_set() or self._greeting_active:
            return
        if not self.caller_listening:
            return
        if self._other_active_tasks():
            return
        if not self.workflow_runner.node_waits_for_caller():
            return
        if not self.workflow_runner.find_no_response_target():
            return
        source_id = self.workflow_runner.current_node_id
        via = (
            "no-response"
            if self.workflow_runner.has_explicit_no_response_wire()
            else "ai-out"
        )
        next_id = self.workflow_runner.advance_no_response()
        if not next_id:
            return
        logger.info(
            f"[SILENCE] {via} from node={source_id} → node={next_id} after {timeout}s"
        )
        await self.call_logger.log_event(
            "silence_timeout",
            node_id=source_id,
            payload={"via": via, "nextNodeId": next_id, "timeoutSec": timeout},
        )
        self._set_pending_react(
            next_id,
            "[No response]",
            self.workflow_runner.get_message(source_id),
        )
        await self._speak_entered_node(next_id, self._turn_cancel)

    async def _schedule_silence_advance(self):
        if self.is_closing or self._greeting_active or self.stop_event.is_set():
            return
        if not self.caller_listening:
            return
        if not self.workflow_runner.node_waits_for_caller():
            return
        if not self.workflow_runner.find_no_response_target():
            return
        await self._cancel_silence_advance()
        self._silence_timer_task = asyncio.create_task(self._silence_wait_and_advance())

    async def _enter_ai_output(self):
        self.caller_listening = False
        self._playback_done.clear()
        await self._cancel_silence_advance()

    async def _await_playback_done(self, cancel: asyncio.Event):
        while not self._playback_done.is_set():
            if cancel.is_set() or self.stop_event.is_set() or self.is_closing:
                return
            await asyncio.sleep(0.05)

    async def _pause_before_next_node(self, cancel: asyncio.Event | None = None):
        """Default gap between nodes when we are not waiting for the caller."""
        gap = NODE_GAP_SEC
        elapsed = 0.0
        step = 0.05
        while elapsed < gap:
            if self.stop_event.is_set() or self.is_closing:
                return
            if cancel is not None and cancel.is_set():
                return
            await asyncio.sleep(step)
            elapsed += step

    async def _on_caller_ready(self):
        # Wait until buffered AI audio has actually finished playing before
        # reopening the mic. With paced playback, TTS generation completes well
        # before the audio drains; opening the mic early lets the AI's own voice
        # (via acoustic echo on the phone) trigger a false speech_start that cuts
        # the AI off mid-response. No-op for transports without a playback buffer.
        await self.transport.wait_drained()
        self._playback_done.set()

        # No reply expected (e.g. intro): short gap, then advance — no 3s silence.
        if not self.workflow_runner.node_waits_for_caller():
            if self.workflow_runner.is_conversation_node():
                next_id = self.workflow_runner.advance_via_out_edge()
                if next_id:
                    logger.info(
                        f"[WORKFLOW] no-wait auto-advance → node={next_id}"
                    )
                    self.caller_listening = False
                    await self._speak_entered_node(next_id, self._turn_cancel)
                    return
            self.caller_listening = False
            return

        self.caller_listening = True
        logger.info("[LISTENING] Caller ready — mic open, silence timer armed")
        await self._schedule_silence_advance()
        self._schedule_info_prefetch()

    def _schedule_info_prefetch(self):
        if self._prefetch_task and not self._prefetch_task.done():
            return
        node_id = self.workflow_runner.current_node_id
        if node_id != "permission":
            return
        target = self.workflow_runner.peek_branch_target("permission-yes", node_id)
        if not target or not self.workflow_runner.is_user_input_node(target):
            return
        if target in self._prefetch_cache:
            return
        self._prefetch_task = asyncio.create_task(self._prefetch_info_node(target))

    async def _prefetch_info_node(self, target_id: str):
        if self.stop_event.is_set() or self.is_closing:
            return
        instruction = self.workflow_runner.get_instruction(target_id)
        if not instruction:
            instruction = "Check context and tell the user all relevant details."
        text = await llm_module.prefetch_context_tell_text(
            context=self.base_context,
            instruction=instruction,
            node_title=self.workflow_runner.get_title(target_id),
            node_id=target_id,
        )
        if text and not self.stop_event.is_set():
            self._prefetch_cache[target_id] = text

    async def _resume_silence_if_waiting(self):
        if self.caller_listening and self.workflow_runner.node_waits_for_caller():
            await self._schedule_silence_advance()

    async def _abort_tts(self):
        if self.is_closing:
            return
        await self.tts_session.abort()
        await self.transport.clear_output()

    async def _send_pcm_chunk(self, chunk: bytes, cancel: asyncio.Event):
        if cancel.is_set() or self.stop_event.is_set():
            return
        if not self._first_pcm_logged and self._llm_start_at is not None:
            elapsed_ms = (time.monotonic() - self._llm_start_at) * 1000
            logger.info(f"[TTS TIMING] llm_start → first_pcm_to_client={elapsed_ms:.0f}ms")
            self._first_pcm_logged = True
        await self.transport.send_pcm(chunk)

    async def _begin_tts_turn(self, cancel: asyncio.Event, tts_lang: str):
        if cancel.is_set() or self.stop_event.is_set():
            return

        async def on_chunk(chunk: bytes):
            await self._send_pcm_chunk(chunk, cancel)

        await self._enter_ai_output()
        await self._send(_tts_start_event(self.transport.output_sample_rate))
        await self.tts_session.begin_turn(tts_lang, on_chunk)

    async def _finish_tts_turn(self, cancel: asyncio.Event, fallback_text: str, tts_lang: str):
        if cancel.is_set() or self.stop_event.is_set():
            return
        try:
            ok = await self.tts_session.end_turn()
            if ok and not cancel.is_set():
                await self._send({"type": "tts_end"})
                await self.call_logger.complete_ai_turn(fallback_text)
                if self.transport.auto_playback_ack:
                    await self._on_caller_ready()
            else:
                logger.warning("[TTS] Stream failed — falling back to speak_full")
                await self.tts_session.abort()
                await self._await_tts_prewarm(tts_lang, after_abort=True)
                await self._speak_full_turn(fallback_text, tts_lang, cancel)
        except Exception as e:
            logger.error(f"[TTS] end_turn error: {e}")
            await self.tts_session.abort()
            await self._await_tts_prewarm(tts_lang, after_abort=True)
            await self._speak_full_turn(fallback_text, tts_lang, cancel)

    async def _speak_full_turn(
        self, text: str, tts_lang: str, cancel: asyncio.Event, cancellable: bool = True
    ):
        if self.stop_event.is_set() or (cancellable and cancel.is_set()):
            return

        await self._enter_ai_output()
        await self._send(_tts_start_event(self.transport.output_sample_rate))

        async def on_chunk(chunk: bytes):
            if cancellable and (cancel.is_set() or self.stop_event.is_set()):
                return
            await self.transport.send_pcm(chunk)

        async def on_done():
            if cancellable and cancel.is_set():
                await self._send({"type": "tts_end"})
            elif not cancellable or not cancel.is_set():
                await self._send({"type": "tts_end"})
                await self.call_logger.complete_ai_turn(text)
                if self.transport.auto_playback_ack:
                    await self._on_caller_ready()

        try:
            await self.tts_session.speak_full(text, tts_lang, on_chunk, on_done)
        except asyncio.CancelledError:
            logger.info("[TTS] speak_full cancelled")
            await self._send({"type": "tts_end"})
        except Exception as e:
            logger.error(f"[TTS] speak_full error: {e}")
            await self._send({"type": "tts_end"})

    async def _end_session(self):
        if self.is_closing:
            return
        self.is_closing = True
        logger.info("[SESSION] Closing after goodbye")
        await self.call_logger.flush_ai_interrupted()
        await self.call_logger.log_event(
            "session_end", node_id=self.workflow_runner.current_node_id
        )
        await db_module.mark_session_completed(self.session_id)
        await self._send({"type": "session_end"})
        self.stop_event.set()
        await asyncio.sleep(0.5)
        await self.transport.close_connection()

    async def _speak_scripted(
        self, text: str, tts_lang: str, cancel: asyncio.Event, hangup_after: bool
    ):
        if cancel.is_set() or self.stop_event.is_set() or not text:
            return
        await self._enter_ai_output()
        await self.call_logger.start_ai_turn(node_id=self.workflow_runner.current_node_id)
        await self._send({"type": "llm_start"})
        await self._speak_full_turn(text, tts_lang, cancel, cancellable=not hangup_after)
        await self._send({"type": "llm_end", "text": text})
        if hangup_after:
            await self._send({"type": "farewell_start"})
            await self._end_session()

    def _set_pending_react(self, target_id: str, transcript: str, prior_message: str):
        if self.workflow_runner.is_react_node(target_id):
            self._pending_react_transcript = transcript
            self._pending_react_prior_message = prior_message or ""
        else:
            self._pending_react_transcript = None
            self._pending_react_prior_message = None

    async def _speak_entered_node(self, target_id: str, cancel: asyncio.Event):
        self.workflow_runner.current_node_id = target_id

        if self.workflow_runner.is_end_node(target_id):
            await self._end_session()
            return

        # Short beat between every node before AI speaks again.
        await self._pause_before_next_node(cancel)
        if cancel.is_set() or self.stop_event.is_set() or self.is_closing:
            return

        if self.workflow_runner.is_react_node(target_id):
            react_transcript = self._pending_react_transcript or "[No response]"
            react_prior = self._pending_react_prior_message or ""
            self._pending_react_transcript = None
            self._pending_react_prior_message = None
            await self._run_context_react(cancel, target_id, react_transcript, react_prior)
            if not self.workflow_runner.get_wait_for_response(target_id):
                await self._await_playback_done(cancel)
                next_id = self.workflow_runner.advance_via_out_edge()
                if next_id:
                    logger.info(f"[WORKFLOW] react auto-advance → node={next_id}")
                    await self._speak_entered_node(next_id, cancel)
            return

        if self.workflow_runner.is_user_input_node(target_id):
            await self._run_context_tell(cancel, target_id)
            if not self.workflow_runner.get_wait_for_response(target_id):
                await self._await_playback_done(cancel)
                next_id = self.workflow_runner.advance_via_out_edge()
                if next_id:
                    logger.info(f"[WORKFLOW] userInput auto-advance → node={next_id}")
                    await self._speak_entered_node(next_id, cancel)
            return

        message = self.workflow_runner.get_message(target_id)
        hangup_after = self.workflow_runner.should_hangup_after_speak(target_id)
        if target_id == "permission":
            self._schedule_info_prefetch()
        if message:
            await self._speak_scripted(message, self._current_tts_lang, cancel, hangup_after)

    async def _advance_via_out_and_speak(
        self, cancel: asyncio.Event, transcript: str = "[Acknowledged]"
    ):
        source_id = self.workflow_runner.current_node_id
        prior_message = self.workflow_runner.get_message(source_id)
        next_id = self.workflow_runner.advance_via_out_edge()
        if not next_id:
            return
        logger.info(f"[WORKFLOW] ai-out from node={source_id} → node={next_id}")
        self._set_pending_react(next_id, transcript, prior_message)
        await self._speak_entered_node(next_id, cancel)

    async def _exit_qa_to_bye(self, cancel: asyncio.Event, transcript: str = ""):
        no_branch = self.workflow_runner.find_no_questions_branch()
        if no_branch:
            await self._advance_and_speak(no_branch, cancel, transcript)
            return
        next_id = self.workflow_runner.advance_no_response()
        if next_id:
            logger.info(f"[QA] limit → no-response node={next_id}")
            await self._speak_entered_node(next_id, cancel)
            return
        bye_id = self.workflow_runner.jump_to_bye()
        if bye_id:
            logger.info(f"[QA] limit → jump bye={bye_id}")
            await self._speak_entered_node(bye_id, cancel)

    async def _advance_and_speak(
        self, branch_id: str, cancel: asyncio.Event, transcript: str = ""
    ):
        source_id = self.workflow_runner.current_node_id
        prior_message = self.workflow_runner.get_message(source_id)
        no_questions_branch = (
            self.workflow_runner.is_qa_node(source_id)
            and branch_id == self.workflow_runner.find_no_questions_branch(source_id)
        )
        target_id = self.workflow_runner.advance(branch_id)
        if not target_id:
            return
        if no_questions_branch:
            self.workflow_runner.mark_qa_handled()
        logger.info(
            f"[WORKFLOW] branch={branch_id} → node={target_id} "
            f"hangup_after={self.workflow_runner.should_hangup_after_speak(target_id)}"
        )
        await self.call_logger.log_event(
            "branch_advance",
            node_id=self.workflow_runner.current_node_id,
            payload={"branchId": branch_id, "targetId": target_id},
        )
        self._set_pending_react(target_id, transcript, prior_message)
        await self._speak_entered_node(target_id, cancel)

    async def _run_context_tell(self, cancel: asyncio.Event, target_id: str | None = None):
        node_id = target_id or self.workflow_runner.current_node_id
        cached = self._prefetch_cache.pop(node_id, None)
        if cached:
            logger.info(f"[CONTEXT_TELL] using prefetch node={node_id}")
            await self.call_logger.start_ai_turn(node_id=node_id)
            await self._send({"type": "llm_start"})
            await self._speak_full_turn(cached, self._current_tts_lang, cancel)
            await self._send({"type": "llm_end", "text": cached})
            await self.call_logger.complete_ai_turn(cached)
            return

        instruction = self.workflow_runner.get_instruction(node_id)
        if not instruction:
            instruction = "Check context and tell the user all relevant details."

        async def on_language_retry():
            self._tts_aborted_for_retry = True
            self._tts_streaming = False
            await self.tts_session.abort()
            self._schedule_tts_prewarm(self._current_tts_lang, after_abort=True)

        try:
            await llm_module.stream_context_tell(
                context=self.base_context,
                instruction=instruction,
                node_title=self.workflow_runner.get_title(node_id),
                event_callback=self.on_event,
                cancel_event=cancel,
                stt_lang=None,
                on_language_retry=on_language_retry,
                node_id=node_id,
            )
        except asyncio.CancelledError:
            self._tts_streaming = False
        except Exception as e:
            logger.error(f"[TURN ERROR] {e}")

    async def _run_context_react(
        self,
        cancel: asyncio.Event,
        target_id: str,
        transcript: str,
        prior_message: str,
    ):
        instruction = self.workflow_runner.get_instruction(target_id)
        if not instruction:
            instruction = "Respond to the caller using the facts and their last message."
        reply_guide = self.workflow_runner.get_reply_guide(target_id)

        async def on_language_retry():
            self._tts_aborted_for_retry = True
            self._tts_streaming = False
            await self.tts_session.abort()
            self._schedule_tts_prewarm(self._current_tts_lang, after_abort=True)

        try:
            await llm_module.stream_context_react(
                transcript=transcript,
                context=self.base_context,
                instruction=instruction,
                node_title=self.workflow_runner.get_title(target_id),
                prior_message=prior_message,
                event_callback=self.on_event,
                cancel_event=cancel,
                stt_lang=None,
                on_language_retry=on_language_retry,
                node_id=target_id,
                reply_guide=reply_guide,
            )
        except asyncio.CancelledError:
            self._tts_streaming = False
        except Exception as e:
            logger.error(f"[TURN ERROR] {e}")

    async def _run_context_qa(
        self,
        transcript: str,
        cancel: asyncio.Event,
        stt_lang: str | None,
        node_message: str,
    ):
        logger.info(
            f"[WORKFLOW] off-script → context Q&A at node={self.workflow_runner.current_node_id} "
            f"transcript={transcript!r}"
        )

        async def on_language_retry():
            self._tts_aborted_for_retry = True
            self._tts_streaming = False
            await self.tts_session.abort()
            self._schedule_tts_prewarm(self._current_tts_lang, after_abort=True)

        try:
            await llm_module.stream_context_answer(
                transcript=transcript,
                context=self.base_context,
                node_title=self.workflow_runner.get_title(),
                node_message=node_message,
                event_callback=self.on_event,
                cancel_event=cancel,
                stt_lang=stt_lang,
                on_language_retry=on_language_retry,
                node_id=self.workflow_runner.current_node_id,
            )
        except asyncio.CancelledError:
            self._tts_streaming = False
        except Exception as e:
            logger.error(f"[TURN ERROR] {e}")

    async def _answer_off_script(
        self,
        transcript: str,
        cancel: asyncio.Event,
        stt_lang: str | None,
        hint: str,
        via: str,
    ):
        logger.info(
            f"[OFF_SCRIPT] {via} node={self.workflow_runner.current_node_id} "
            f"transcript={transcript!r}"
        )
        await self._run_context_qa(transcript, cancel, stt_lang, hint)

    async def on_event(
        self,
        event_type: str,
        text: str,
        stt_lang: str | None = None,
        response_lang: str | None = None,
        is_final: bool | None = None,
    ):
        if event_type == "speech_start":
            if self.is_closing:
                return
            if not self.caller_listening:
                return
            if self._greeting_active:
                logger.info("[VAD] Greeting in progress — ignoring speech_start interrupt")
                return

            self._tts_streaming = False
            await self._abort_tts()
            self._schedule_tts_prewarm(self._current_tts_lang, after_abort=True)
            await self._cancel_silence_advance()

            await self.call_logger.flush_ai_interrupted()
            await self.call_logger.log_event(
                "speech_start", node_id=self.workflow_runner.current_node_id
            )

            if self._active_tasks:
                logger.info(f"[VAD INTERRUPT] Cancelling {len(self._active_tasks)} task(s)")
                self._interrupt()
                await self._send({"type": "interrupted"})
            self._start_new_turn()
            self._transcript_buffer = []
            self._turn_stt_lang = None
            await self._send({"type": "speech_start"})

        elif event_type == "transcript" and text:
            if self.is_closing or self._greeting_active or not self.caller_listening:
                return

            if stt_lang:
                self._turn_stt_lang = stt_lang
            self._transcript_buffer.append(text)
            await self._send({"type": "transcript", "text": text})

            if is_final is True:
                self._maybe_start_turn(text)
            elif self._speech_ended:
                self._maybe_start_turn(text)

        elif event_type == "speech_end":
            if self.is_closing or self._greeting_active or not self.caller_listening:
                return

            await self._send({"type": "speech_end"})
            if self._transcript_buffer:
                self._maybe_start_turn(self._transcript_buffer[-1])
            else:
                self._speech_ended = True
                self._schedule_tts_prewarm(self._current_tts_lang)

        else:
            payload = {"type": event_type}
            if text:
                payload["token" if event_type == "llm_token" else "text"] = text
            await self._send(payload)

            if event_type == "llm_start":
                if self._turn_cancel.is_set() or self.stop_event.is_set():
                    return
                await self._enter_ai_output()
                self._llm_start_at = time.monotonic()
                self._tts_streaming = True
                await self.call_logger.start_ai_turn(
                    node_id=self.workflow_runner.current_node_id,
                    metadata={"responseLang": response_lang} if response_lang else None,
                )
                await self._begin_tts_turn(self._turn_cancel, self._current_tts_lang)

            elif event_type == "llm_token" and text and self._tts_streaming:
                if self._turn_cancel.is_set() or self.stop_event.is_set():
                    return
                self.call_logger.append_ai_token(text)
                await self.tts_session.feed_text(text)

            elif event_type == "llm_end" and text:
                if self._turn_cancel.is_set() or self.stop_event.is_set():
                    self._tts_streaming = False
                    await self.call_logger.flush_ai_interrupted(full_generated=text)
                    return

                tts_lang = llm_module.tts_code_for_language(
                    response_lang or self._last_lang or "english"
                )

                if self._tts_aborted_for_retry:
                    self._tts_streaming = False
                    self._tts_aborted_for_retry = False
                    await self._await_tts_prewarm(tts_lang, after_abort=True)
                    await self._speak_full_turn(text, tts_lang, self._turn_cancel)
                elif self._tts_streaming:
                    self._tts_streaming = False
                    await self._finish_tts_turn(self._turn_cancel, text, tts_lang)
                else:
                    await self._speak_full_turn(text, tts_lang, self._turn_cancel)

    async def _run_turn(
        self, transcript: str, cancel: asyncio.Event, stt_lang: str | None = None
    ):
        if cancel.is_set() or self.stop_event.is_set() or self.is_closing:
            return

        try:
            await self._run_turn_body(transcript, cancel, stt_lang)
        finally:
            await self._resume_silence_if_waiting()

    async def _run_turn_body(
        self, transcript: str, cancel: asyncio.Event, stt_lang: str | None = None
    ):
        lang = llm_module.resolve_response_language(stt_lang, transcript)
        if self._last_lang is not None and lang != self._last_lang:
            self.conversation_history.clear()
        self._last_lang = lang
        self._current_tts_lang = llm_module.tts_code_for_language(lang)
        self._tts_aborted_for_retry = False
        self._tts_streaming = False

        if self.workflow_runner.has_graph():
            node = self.workflow_runner.get_current_node()
            branches = self.workflow_runner.get_branches()
            node_message = self.workflow_runner.get_message()

            if node and llm_module.looks_like_farewell(transcript):
                goodbye = llm_module.farewell_message_for_language(lang)
                logger.info(
                    f"[FAREWELL] node={self.workflow_runner.current_node_id} "
                    f"transcript={transcript!r} message={goodbye!r}"
                )
                await self._speak_scripted(
                    goodbye, self._current_tts_lang, cancel, hangup_after=True
                )
                return

            if node and llm_module.looks_like_refuse_talk(transcript):
                bye_id = self.workflow_runner.jump_to_bye()
                logger.info(
                    f"[REFUSE] node={self.workflow_runner.current_node_id} "
                    f"transcript={transcript!r} → bye={bye_id}"
                )
                if bye_id:
                    await self._speak_entered_node(bye_id, cancel)
                else:
                    goodbye = llm_module.farewell_message_for_language(lang)
                    await self._speak_scripted(
                        goodbye, self._current_tts_lang, cancel, hangup_after=True
                    )
                return

            if node and llm_module.looks_like_filler(transcript):
                logger.info(
                    f"[FILLER] ignored node={self.workflow_runner.current_node_id} "
                    f"transcript={transcript!r}"
                )
                return

            if node and llm_module.looks_like_noise(transcript):
                logger.info(
                    f"[NOISE] ignored node={self.workflow_runner.current_node_id} "
                    f"transcript={transcript!r}"
                )
                return

            if self.workflow_runner.is_user_input_node() and node:
                instruction = self.workflow_runner.get_instruction() or node_message
                if branches:
                    if llm_module.looks_like_acknowledgment(transcript):
                        continue_id = llm_module.find_continue_branch(branches)
                        if continue_id:
                            logger.info(
                                f"[ACK] userInput node={self.workflow_runner.current_node_id} "
                                f"transcript={transcript!r} branch={continue_id}"
                            )
                            await self._advance_and_speak(continue_id, cancel, transcript)
                            return

                    if llm_module.looks_like_factual_question(transcript):
                        await self._run_context_qa(transcript, cancel, stt_lang, instruction)
                        return

                    branch_id = await llm_module.classify_branch(
                        transcript, branches, instruction
                    )
                    if branch_id:
                        await self._advance_and_speak(branch_id, cancel, transcript)
                        return

                    await self._answer_off_script(
                        transcript, cancel, stt_lang, instruction, "userInput"
                    )
                    return

                if llm_module.looks_like_acknowledgment(transcript):
                    logger.info(
                        f"[ACK] userInput node={self.workflow_runner.current_node_id} "
                        f"transcript={transcript!r}"
                    )
                    await self._advance_via_out_and_speak(cancel, transcript)
                    return

                if llm_module.looks_like_factual_question(transcript):
                    await self._run_context_qa(transcript, cancel, stt_lang, instruction)
                    return

                await self._answer_off_script(
                    transcript, cancel, stt_lang, instruction, "userInput"
                )
                return

            if self.workflow_runner.is_react_node() and node:
                instruction = self.workflow_runner.get_instruction() or node_message
                if branches:
                    if llm_module.looks_like_acknowledgment(transcript):
                        continue_id = llm_module.find_continue_branch(branches)
                        if continue_id:
                            logger.info(
                                f"[ACK] react node={self.workflow_runner.current_node_id} "
                                f"transcript={transcript!r} branch={continue_id}"
                            )
                            await self._advance_and_speak(continue_id, cancel, transcript)
                            return

                    if llm_module.looks_like_factual_question(transcript):
                        await self._run_context_qa(transcript, cancel, stt_lang, instruction)
                        return

                    branch_id = await llm_module.classify_branch(
                        transcript, branches, instruction
                    )
                    if branch_id:
                        await self._advance_and_speak(branch_id, cancel, transcript)
                        return

                    await self._answer_off_script(
                        transcript, cancel, stt_lang, instruction, "react"
                    )
                    return

                if llm_module.looks_like_acknowledgment(transcript):
                    logger.info(
                        f"[ACK] react node={self.workflow_runner.current_node_id} "
                        f"transcript={transcript!r}"
                    )
                    await self._advance_via_out_and_speak(cancel, transcript)
                    return

                if llm_module.looks_like_factual_question(transcript):
                    await self._run_context_qa(transcript, cancel, stt_lang, instruction)
                    return

                await self._answer_off_script(
                    transcript, cancel, stt_lang, instruction, "react"
                )
                return

            if self.workflow_runner.is_conversation_node() and node and branches:
                branch_id = llm_module.match_branch_local(transcript, branches)
                if branch_id:
                    logger.info(
                        f"[LOCAL] node={self.workflow_runner.current_node_id} "
                        f"transcript={transcript!r} branch={branch_id}"
                    )
                    await self._advance_and_speak(branch_id, cancel, transcript)
                    return

                if llm_module.looks_like_acknowledgment(transcript):
                    continue_id = llm_module.find_continue_branch(branches)
                    if continue_id:
                        logger.info(
                            f"[ACK] node={self.workflow_runner.current_node_id} "
                            f"transcript={transcript!r} branch={continue_id}"
                        )
                        await self._advance_and_speak(continue_id, cancel, transcript)
                        return

                if llm_module.looks_like_factual_question(transcript):
                    await self._run_context_qa(transcript, cancel, stt_lang, node_message)
                    return

                branch_id = await llm_module.classify_branch(
                    transcript, branches, node_message
                )
                if branch_id:
                    await self._advance_and_speak(branch_id, cancel, transcript)
                    return

                await self._answer_off_script(
                    transcript, cancel, stt_lang, node_message, "conversation"
                )
                return

            if self.workflow_runner.is_qa_node() and node:
                if llm_module.looks_like_filler(transcript) or llm_module.looks_like_noise(
                    transcript
                ):
                    logger.info(
                        f"[QA] filler/noise ignored node={self.workflow_runner.current_node_id} "
                        f"transcript={transcript!r}"
                    )
                    return

                if llm_module.looks_like_negative(transcript):
                    no_branch = self.workflow_runner.find_no_questions_branch()
                    if no_branch:
                        logger.info(
                            f"[QA] decline node={self.workflow_runner.current_node_id} "
                            f"transcript={transcript!r} branch={no_branch}"
                        )
                        await self._advance_and_speak(no_branch, cancel, transcript)
                        return

                if llm_module.looks_like_factual_question(transcript):
                    await self._run_context_qa(transcript, cancel, stt_lang, node_message)
                    count = self.workflow_runner.record_qa_answer()
                    logger.info(
                        f"[QA] answered count={count}/{self.workflow_runner.MAX_QA_ANSWERS} "
                        f"node={self.workflow_runner.current_node_id}"
                    )
                    if self.workflow_runner.qa_limit_reached():
                        await self._exit_qa_to_bye(cancel, transcript)
                    return

                if llm_module.looks_like_acknowledgment(transcript):
                    logger.info(
                        f"[QA_REPLAY] node={self.workflow_runner.current_node_id} "
                        f"transcript={transcript!r}"
                    )
                    if self.workflow_runner.qa_limit_reached():
                        await self._exit_qa_to_bye(cancel, transcript)
                        return
                    await self._speak_scripted(
                        "Any other questions?",
                        self._current_tts_lang,
                        cancel,
                        hangup_after=False,
                    )
                    return

                if branches:
                    branch_id = await llm_module.classify_branch(
                        transcript, branches, node_message
                    )
                    if branch_id:
                        await self._advance_and_speak(branch_id, cancel, transcript)
                        return

                logger.info(
                    f"[QA] non-question at node={self.workflow_runner.current_node_id} "
                    f"transcript={transcript!r}"
                )
                await self._speak_scripted(
                    "Any other questions?",
                    self._current_tts_lang,
                    cancel,
                    hangup_after=False,
                )
                return

            if branches and node:
                branch_id = await llm_module.classify_branch(
                    transcript, branches, node_message
                )
                if branch_id:
                    await self._advance_and_speak(branch_id, cancel, transcript)
                    return

            if node:
                logger.info(
                    f"[UNHANDLED] node={self.workflow_runner.current_node_id} "
                    f"transcript={transcript!r}"
                )
                return

        system_prompt = llm_module.build_system_prompt(
            self.base_context, self.base_example, self.voice_session.end_points
        )

        async def on_language_retry():
            self._tts_aborted_for_retry = True
            self._tts_streaming = False
            await self.tts_session.abort()
            self._schedule_tts_prewarm(self._current_tts_lang, after_abort=True)

        try:
            await llm_module.stream_llm_response(
                transcript=transcript,
                conversation_history=self.conversation_history,
                event_callback=self.on_event,
                cancel_event=cancel,
                stt_lang=stt_lang,
                on_language_retry=on_language_retry,
                system_prompt=system_prompt,
            )
        except asyncio.CancelledError:
            self._tts_streaming = False
        except Exception as e:
            logger.error(f"[TURN ERROR] {e}")

    async def _run_greeting(self):
        try:
            logger.info(f"[GREETING] Playing: {self.greeting!r}")
            await self.call_logger.start_ai_turn(
                node_id=self.workflow_runner.current_node_id
            )
            await self._send({"type": "greeting_start", "text": self.greeting})
            await self._speak_full_turn(self.greeting, "en-IN", self._turn_cancel, cancellable=False)
            await self.call_logger.log_event("greeting_end", payload={"text": self.greeting})
        except Exception as e:
            logger.error(f"[GREETING] Failed: {e}")
        finally:
            self._greeting_active = False
            await self._send({"type": "greeting_end"})
            self._schedule_tts_prewarm("en-IN")

    async def _session_startup(self):
        try:
            await self.tts_session.prewarm("en-IN")
            await self._run_greeting()
        except Exception as e:
            logger.error(f"[SESSION STARTUP] {e}")
            self._greeting_active = False
            await self._send({"type": "greeting_end"})

    async def handle_client_interrupt(self):
        if self.is_closing or self._greeting_active:
            return

        await self.call_logger.flush_ai_interrupted()
        await self.call_logger.log_event(
            "client_interrupt", node_id=self.workflow_runner.current_node_id
        )

        self._tts_streaming = False
        await self._abort_tts()
        self._schedule_tts_prewarm(self._current_tts_lang, after_abort=True)

        if self._active_tasks:
            self._interrupt()
            await self._send({"type": "interrupted"})
            self._start_new_turn()
            self._transcript_buffer.clear()

        self.caller_listening = True
        logger.info("[LISTENING] Caller ready after barge-in")

    async def handle_tts_playback_done(self):
        if self.is_closing or self.stop_event.is_set():
            return
        await self._on_caller_ready()

    async def run(self) -> None:
        await db_module.mark_session_started(self.session_id)
        await self.call_logger.log_event(self._connect_event)

        stt_task = asyncio.create_task(
            run_streaming_stt(self.audio_queue, self.on_event, self.stop_event)
        )
        asyncio.create_task(self._session_startup())

        try:
            await self.transport.run_receive_loop(self)
        finally:
            self.stop_event.set()
            self._interrupt()
            await self.tts_session.close()
            await self.audio_queue.put(None)
            try:
                await asyncio.wait_for(stt_task, timeout=3.0)
            except asyncio.TimeoutError:
                stt_task.cancel()
            logger.info("[SESSION CLOSED]")
