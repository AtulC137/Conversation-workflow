"""
server.py — greeting + workflow-driven turns + interrupt + TTS WebSocket pipeline.
"""

import asyncio
import json
import logging
import sys
import time

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from stt import run_streaming_stt
import llm as llm_module
import tts as tts_module
from tts import TtsWsSession
import db as db_module
from call_logger import CallLogger
from sessions import create_session, get_session_async
from workflow_runner import WorkflowRunner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("server")

app = FastAPI(title="Voice Workflow Assistant")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

PCM_TTS_START = {"type": "tts_start", "format": "pcm_s16le", "sampleRate": 16000}


class SessionCreateBody(BaseModel):
    sessionId: str | None = None
    context: str = ""
    example: str = ""
    endPoints: list[str] = Field(default_factory=list)
    greeting: str | None = None
    graph: dict = Field(default_factory=dict)


@app.on_event("startup")
async def startup():
    await db_module.init_pool()


@app.on_event("shutdown")
async def shutdown():
    await llm_module.close()
    await tts_module.close()
    await db_module.close_pool()


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/sessions")
async def create_voice_session(body: SessionCreateBody):
    session_id = create_session(body.model_dump(), session_id=body.sessionId)
    logger.info(f"[SESSION CREATED] {session_id}")
    return {"sessionId": session_id}


@app.get("/sessions/{session_id}")
async def get_voice_session(session_id: str):
    session = await get_session_async(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found or expired")
    return {
        "sessionId": session_id,
        "context": session.context,
        "example": session.example,
        "endPoints": session.end_points,
        "greeting": session.greeting,
        "graph": session.graph,
    }


@app.websocket("/ws/audio")
async def audio_ws(websocket: WebSocket):
    session_id = websocket.query_params.get("sessionId")
    if not session_id:
        await websocket.close(code=4000, reason="sessionId query param required")
        return

    voice_session = await get_session_async(session_id)
    if voice_session is None:
        await websocket.close(code=4004, reason="Session not found or expired")
        return

    await websocket.accept()
    logger.info(f"[CLIENT CONNECTED] session={session_id}")

    call_logger = CallLogger(session_id)
    await db_module.mark_session_started(session_id)
    await call_logger.log_event("ws_connected")

    workflow_runner = WorkflowRunner(voice_session.graph)
    base_context = voice_session.context
    base_example = voice_session.example
    greeting = voice_session.resolve_greeting()

    audio_queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    stop_event = asyncio.Event()
    conversation_history: list = []
    _transcript_buffer: list = []

    _active_tasks: set = set()
    _turn_cancel: asyncio.Event = asyncio.Event()

    _speech_ended: bool = False
    _is_closing: bool = False
    _greeting_active: bool = True
    _llm_spawned_this_turn: bool = False

    _turn_stt_lang: str | None = None
    _last_lang: str | None = None
    _current_tts_lang: str = "en-IN"
    _tts_streaming: bool = False
    _tts_aborted_for_retry: bool = False

    _llm_start_at: float | None = None
    _first_pcm_logged: bool = False
    _prewarm_task: asyncio.Task | None = None
    _silence_timer_task: asyncio.Task | None = None
    _caller_listening: bool = False
    _pending_react_transcript: str | None = None
    _pending_react_prior_message: str | None = None

    tts_session = TtsWsSession()

    def _spawn(coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        _active_tasks.add(task)
        task.add_done_callback(_active_tasks.discard)
        return task

    def _other_active_tasks() -> set:
        exclude = {_silence_timer_task} if _silence_timer_task else set()
        return _active_tasks - exclude

    def _schedule_tts_prewarm(lang: str = "en-IN", *, after_abort: bool = False):
        nonlocal _prewarm_task
        if _prewarm_task and not _prewarm_task.done():
            return
        _prewarm_task = asyncio.create_task(
            tts_session.prewarm(lang, after_abort=after_abort)
        )

    async def _cancel_prewarm_task():
        nonlocal _prewarm_task
        if _prewarm_task and not _prewarm_task.done():
            _prewarm_task.cancel()
            try:
                await _prewarm_task
            except asyncio.CancelledError:
                pass
        _prewarm_task = None

    async def _await_tts_prewarm(lang: str, *, after_abort: bool = False):
        await _cancel_prewarm_task()
        await tts_session.prewarm(lang, after_abort=after_abort)

    def _interrupt():
        if _is_closing:
            return
        _turn_cancel.set()
        for t in list(_active_tasks):
            t.cancel()
        _spawn(_cancel_silence_advance())

    def _start_new_turn():
        nonlocal _turn_cancel, _speech_ended, _llm_start_at, _first_pcm_logged, _llm_spawned_this_turn
        _turn_cancel = asyncio.Event()
        _speech_ended = False
        _llm_spawned_this_turn = False
        _llm_start_at = None
        _first_pcm_logged = False

    async def _send(payload: dict):
        try:
            await websocket.send_text(json.dumps(payload))
        except Exception:
            pass

    async def _cancel_silence_advance():
        nonlocal _silence_timer_task
        if _silence_timer_task and not _silence_timer_task.done():
            _silence_timer_task.cancel()
            try:
                await _silence_timer_task
            except asyncio.CancelledError:
                pass
        _silence_timer_task = None

    def _maybe_start_turn(transcript: str):
        nonlocal _llm_spawned_this_turn, _speech_ended
        if _llm_spawned_this_turn or _is_closing or _greeting_active or _turn_cancel.is_set():
            return
        _spawn(_cancel_silence_advance())
        _llm_spawned_this_turn = True
        _speech_ended = False
        logger.info(f"[TURN END] processing: {transcript!r}")
        _spawn(call_logger.log_caller(
            transcript,
            node_id=workflow_runner.current_node_id,
            metadata={"sttLang": _turn_stt_lang} if _turn_stt_lang else None,
        ))
        _spawn(_run_turn(transcript, _turn_cancel, _turn_stt_lang))

    async def _silence_wait_and_advance():
        timeout = workflow_runner.get_silence_timeout_sec()
        try:
            await asyncio.sleep(timeout)
        except asyncio.CancelledError:
            return
        if _is_closing or stop_event.is_set() or _greeting_active:
            return
        if not _caller_listening:
            return
        if _other_active_tasks():
            return
        if not workflow_runner.node_waits_for_caller():
            return
        if not workflow_runner.find_no_response_target():
            return
        source_id = workflow_runner.current_node_id
        via = (
            "no-response"
            if workflow_runner.has_explicit_no_response_wire()
            else "ai-out"
        )
        next_id = workflow_runner.advance_no_response()
        if not next_id:
            return
        logger.info(
            f"[SILENCE] {via} from node={source_id} → node={next_id} "
            f"after {timeout}s"
        )
        await call_logger.log_event(
            "silence_timeout",
            node_id=source_id,
            payload={"via": via, "nextNodeId": next_id, "timeoutSec": timeout},
        )
        _set_pending_react(
            next_id,
            "[No response]",
            workflow_runner.get_message(source_id),
        )
        await _speak_entered_node(next_id, _turn_cancel)

    async def _schedule_silence_advance():
        nonlocal _silence_timer_task
        if _is_closing or _greeting_active or stop_event.is_set():
            return
        if not _caller_listening:
            return
        if not workflow_runner.node_waits_for_caller():
            return
        if not workflow_runner.find_no_response_target():
            return
        await _cancel_silence_advance()
        _silence_timer_task = asyncio.create_task(_silence_wait_and_advance())

    async def _enter_ai_output():
        nonlocal _caller_listening
        _caller_listening = False
        await _cancel_silence_advance()

    async def _on_caller_ready():
        nonlocal _caller_listening
        _caller_listening = True
        logger.info("[LISTENING] Caller ready — mic open, silence timer armed")
        await _schedule_silence_advance()

    async def _resume_silence_if_waiting():
        if _caller_listening and workflow_runner.node_waits_for_caller():
            await _schedule_silence_advance()

    async def _abort_tts():
        if _is_closing:
            return
        await tts_session.abort()

    async def _send_pcm_chunk(chunk: bytes, cancel: asyncio.Event):
        nonlocal _first_pcm_logged
        if cancel.is_set() or stop_event.is_set():
            return
        if not _first_pcm_logged and _llm_start_at is not None:
            elapsed_ms = (time.monotonic() - _llm_start_at) * 1000
            logger.info(f"[TTS TIMING] llm_start → first_pcm_to_client={elapsed_ms:.0f}ms")
            _first_pcm_logged = True
        try:
            await websocket.send_bytes(chunk)
        except Exception:
            pass

    async def _begin_tts_turn(cancel: asyncio.Event, tts_lang: str):
        if cancel.is_set() or stop_event.is_set():
            return

        async def on_chunk(chunk: bytes):
            await _send_pcm_chunk(chunk, cancel)

        await _enter_ai_output()
        await _send(PCM_TTS_START)
        await tts_session.begin_turn(tts_lang, on_chunk)

    async def _finish_tts_turn(cancel: asyncio.Event, fallback_text: str, tts_lang: str):
        if cancel.is_set() or stop_event.is_set():
            return
        try:
            ok = await tts_session.end_turn()
            if ok and not cancel.is_set():
                await _send({"type": "tts_end"})
                await call_logger.complete_ai_turn(fallback_text)
            else:
                logger.warning("[TTS] Stream failed — falling back to speak_full")
                await tts_session.abort()
                await _await_tts_prewarm(tts_lang, after_abort=True)
                await _speak_full_turn(fallback_text, tts_lang, cancel)
        except Exception as e:
            logger.error(f"[TTS] end_turn error: {e}")
            await tts_session.abort()
            await _await_tts_prewarm(tts_lang, after_abort=True)
            await _speak_full_turn(fallback_text, tts_lang, cancel)

    async def _speak_full_turn(text: str, tts_lang: str, cancel: asyncio.Event, cancellable: bool = True):
        if stop_event.is_set() or (cancellable and cancel.is_set()):
            return

        await _enter_ai_output()
        await _send(PCM_TTS_START)

        async def on_chunk(chunk: bytes):
            if cancellable and (cancel.is_set() or stop_event.is_set()):
                return
            try:
                await websocket.send_bytes(chunk)
            except Exception:
                pass

        async def on_done():
            if cancellable and cancel.is_set():
                await _send({"type": "tts_end"})
            elif not cancellable or not cancel.is_set():
                await _send({"type": "tts_end"})
                if not cancellable:
                    await call_logger.complete_ai_turn(text)
                elif cancellable:
                    await call_logger.complete_ai_turn(text)

        try:
            await tts_session.speak_full(text, tts_lang, on_chunk, on_done)
        except asyncio.CancelledError:
            logger.info("[TTS] speak_full cancelled")
            await _send({"type": "tts_end"})
        except Exception as e:
            logger.error(f"[TTS] speak_full error: {e}")
            await _send({"type": "tts_end"})

    async def _end_session():
        nonlocal _is_closing
        if _is_closing:
            return
        _is_closing = True
        logger.info("[SESSION] Closing after goodbye")
        await call_logger.flush_ai_interrupted()
        await call_logger.log_event("session_end", node_id=workflow_runner.current_node_id)
        await db_module.mark_session_completed(session_id)
        await _send({"type": "session_end"})
        stop_event.set()
        await asyncio.sleep(0.5)
        try:
            await websocket.close()
        except Exception:
            pass

    async def _speak_scripted(text: str, tts_lang: str, cancel: asyncio.Event, hangup_after: bool):
        if cancel.is_set() or stop_event.is_set() or not text:
            return
        await _enter_ai_output()
        await call_logger.start_ai_turn(node_id=workflow_runner.current_node_id)
        await _send({"type": "llm_start"})
        await _speak_full_turn(text, tts_lang, cancel, cancellable=not hangup_after)
        await _send({"type": "llm_end", "text": text})
        if hangup_after:
            await _send({"type": "farewell_start"})
            await _end_session()

    def _set_pending_react(target_id: str, transcript: str, prior_message: str):
        nonlocal _pending_react_transcript, _pending_react_prior_message
        if workflow_runner.is_react_node(target_id):
            _pending_react_transcript = transcript
            _pending_react_prior_message = prior_message or ""
        else:
            _pending_react_transcript = None
            _pending_react_prior_message = None

    async def _speak_entered_node(target_id: str, cancel: asyncio.Event):
        nonlocal _pending_react_transcript, _pending_react_prior_message
        workflow_runner.current_node_id = target_id

        if workflow_runner.is_end_node(target_id):
            await _end_session()
            return

        if workflow_runner.is_react_node(target_id):
            react_transcript = _pending_react_transcript or "[No response]"
            react_prior = _pending_react_prior_message or ""
            _pending_react_transcript = None
            _pending_react_prior_message = None
            await _run_context_react(cancel, target_id, react_transcript, react_prior)
            if not workflow_runner.get_wait_for_response(target_id):
                next_id = workflow_runner.advance_via_out_edge()
                if next_id:
                    logger.info(f"[WORKFLOW] react auto-advance → node={next_id}")
                    await _speak_entered_node(next_id, cancel)
            return

        if workflow_runner.is_user_input_node(target_id):
            await _run_context_tell(cancel, target_id)
            if not workflow_runner.get_wait_for_response(target_id):
                next_id = workflow_runner.advance_via_out_edge()
                if next_id:
                    logger.info(
                        f"[WORKFLOW] userInput auto-advance → node={next_id}"
                    )
                    await _speak_entered_node(next_id, cancel)
            return

        message = workflow_runner.get_message(target_id)
        hangup_after = workflow_runner.should_hangup_after_speak(target_id)
        if message:
            await _speak_scripted(message, _current_tts_lang, cancel, hangup_after)

    async def _advance_via_out_and_speak(cancel: asyncio.Event, transcript: str = "[Acknowledged]"):
        source_id = workflow_runner.current_node_id
        prior_message = workflow_runner.get_message(source_id)
        next_id = workflow_runner.advance_via_out_edge()
        if not next_id:
            return
        logger.info(f"[WORKFLOW] ai-out from node={source_id} → node={next_id}")
        _set_pending_react(next_id, transcript, prior_message)
        await _speak_entered_node(next_id, cancel)

    async def _advance_and_speak(branch_id: str, cancel: asyncio.Event, transcript: str = ""):
        source_id = workflow_runner.current_node_id
        prior_message = workflow_runner.get_message(source_id)
        no_questions_branch = (
            workflow_runner.is_qa_node(source_id)
            and branch_id == workflow_runner.find_no_questions_branch(source_id)
        )
        target_id = workflow_runner.advance(branch_id)
        if not target_id:
            return
        if no_questions_branch:
            workflow_runner.mark_qa_handled()
        logger.info(
            f"[WORKFLOW] branch={branch_id} → node={target_id} "
            f"hangup_after={workflow_runner.should_hangup_after_speak(target_id)}"
        )
        await call_logger.log_event(
            "branch_advance",
            node_id=workflow_runner.current_node_id,
            payload={"branchId": branch_id, "targetId": target_id},
        )
        _set_pending_react(target_id, transcript, prior_message)
        await _speak_entered_node(target_id, cancel)

    async def _run_context_tell(cancel: asyncio.Event, target_id: str | None = None):
        node_id = target_id or workflow_runner.current_node_id
        instruction = workflow_runner.get_instruction(node_id)
        if not instruction:
            instruction = "Check context and tell the user all relevant details."

        async def on_language_retry():
            nonlocal _tts_aborted_for_retry, _tts_streaming
            _tts_aborted_for_retry = True
            _tts_streaming = False
            await tts_session.abort()
            _schedule_tts_prewarm(_current_tts_lang, after_abort=True)

        try:
            await llm_module.stream_context_tell(
                context=base_context,
                instruction=instruction,
                node_title=workflow_runner.get_title(node_id),
                event_callback=on_event,
                cancel_event=cancel,
                stt_lang=None,
                on_language_retry=on_language_retry,
                node_id=node_id,
            )
        except asyncio.CancelledError:
            _tts_streaming = False
        except Exception as e:
            logger.error(f"[TURN ERROR] {e}")

    async def _run_context_react(
        cancel: asyncio.Event,
        target_id: str,
        transcript: str,
        prior_message: str,
    ):
        instruction = workflow_runner.get_instruction(target_id)
        if not instruction:
            instruction = "Respond to the caller using the facts and their last message."
        reply_guide = workflow_runner.get_reply_guide(target_id)

        async def on_language_retry():
            nonlocal _tts_aborted_for_retry, _tts_streaming
            _tts_aborted_for_retry = True
            _tts_streaming = False
            await tts_session.abort()
            _schedule_tts_prewarm(_current_tts_lang, after_abort=True)

        try:
            await llm_module.stream_context_react(
                transcript=transcript,
                context=base_context,
                instruction=instruction,
                node_title=workflow_runner.get_title(target_id),
                prior_message=prior_message,
                event_callback=on_event,
                cancel_event=cancel,
                stt_lang=None,
                on_language_retry=on_language_retry,
                node_id=target_id,
                reply_guide=reply_guide,
            )
        except asyncio.CancelledError:
            _tts_streaming = False
        except Exception as e:
            logger.error(f"[TURN ERROR] {e}")

    async def _run_context_qa(
        transcript: str,
        cancel: asyncio.Event,
        stt_lang: str | None,
        node_message: str,
    ):
        logger.info(
            f"[WORKFLOW] off-script → context Q&A at node={workflow_runner.current_node_id} "
            f"transcript={transcript!r}"
        )

        async def on_language_retry():
            nonlocal _tts_aborted_for_retry, _tts_streaming
            _tts_aborted_for_retry = True
            _tts_streaming = False
            await tts_session.abort()
            _schedule_tts_prewarm(_current_tts_lang, after_abort=True)

        try:
            await llm_module.stream_context_answer(
                transcript=transcript,
                context=base_context,
                node_title=workflow_runner.get_title(),
                node_message=node_message,
                event_callback=on_event,
                cancel_event=cancel,
                stt_lang=stt_lang,
                on_language_retry=on_language_retry,
                node_id=workflow_runner.current_node_id,
            )
        except asyncio.CancelledError:
            _tts_streaming = False
        except Exception as e:
            logger.error(f"[TURN ERROR] {e}")

    async def _answer_off_script(
        transcript: str,
        cancel: asyncio.Event,
        stt_lang: str | None,
        hint: str,
        via: str,
    ):
        logger.info(
            f"[OFF_SCRIPT] {via} node={workflow_runner.current_node_id} "
            f"transcript={transcript!r}"
        )
        await _run_context_qa(transcript, cancel, stt_lang, hint)

    async def on_event(
        event_type: str,
        text: str,
        stt_lang: str | None = None,
        response_lang: str | None = None,
        is_final: bool | None = None,
    ):
        nonlocal _transcript_buffer, _speech_ended, _turn_stt_lang
        nonlocal _tts_streaming, _tts_aborted_for_retry, _llm_start_at

        if event_type == "speech_start":
            if _is_closing:
                return
            if not _caller_listening:
                return
            if _greeting_active:
                logger.info("[VAD] Greeting in progress — ignoring speech_start interrupt")
                return

            _tts_streaming = False
            await _abort_tts()
            _schedule_tts_prewarm(_current_tts_lang, after_abort=True)
            await _cancel_silence_advance()

            await call_logger.flush_ai_interrupted()
            await call_logger.log_event("speech_start", node_id=workflow_runner.current_node_id)

            if _active_tasks:
                logger.info(f"[VAD INTERRUPT] Cancelling {len(_active_tasks)} task(s)")
                _interrupt()
                await _send({"type": "interrupted"})
            _start_new_turn()
            _transcript_buffer = []
            _turn_stt_lang = None
            await _send({"type": "speech_start"})

        elif event_type == "transcript" and text:
            if _is_closing or _greeting_active or not _caller_listening:
                return

            if stt_lang:
                _turn_stt_lang = stt_lang
            _transcript_buffer.append(text)
            await _send({"type": "transcript", "text": text})

            if is_final is True:
                _maybe_start_turn(text)
            elif _speech_ended:
                _maybe_start_turn(text)

        elif event_type == "speech_end":
            if _is_closing or _greeting_active or not _caller_listening:
                return

            await _send({"type": "speech_end"})
            if _transcript_buffer:
                _maybe_start_turn(_transcript_buffer[-1])
            else:
                _speech_ended = True
                _schedule_tts_prewarm(_current_tts_lang)

        else:
            payload = {"type": event_type}
            if text:
                payload["token" if event_type == "llm_token" else "text"] = text
            await _send(payload)

            if event_type == "llm_start":
                if _turn_cancel.is_set() or stop_event.is_set():
                    return
                await _enter_ai_output()
                _llm_start_at = time.monotonic()
                _tts_streaming = True
                await call_logger.start_ai_turn(
                    node_id=workflow_runner.current_node_id,
                    metadata={"responseLang": response_lang} if response_lang else None,
                )
                await _begin_tts_turn(_turn_cancel, _current_tts_lang)

            elif event_type == "llm_token" and text and _tts_streaming:
                if _turn_cancel.is_set() or stop_event.is_set():
                    return
                call_logger.append_ai_token(text)
                await tts_session.feed_text(text)

            elif event_type == "llm_end" and text:
                if _turn_cancel.is_set() or stop_event.is_set():
                    _tts_streaming = False
                    await call_logger.flush_ai_interrupted(full_generated=text)
                    return

                tts_lang = llm_module.tts_code_for_language(response_lang or _last_lang or "english")

                if _tts_aborted_for_retry:
                    _tts_streaming = False
                    _tts_aborted_for_retry = False
                    await _await_tts_prewarm(tts_lang, after_abort=True)
                    await _speak_full_turn(text, tts_lang, _turn_cancel)
                elif _tts_streaming:
                    _tts_streaming = False
                    await _finish_tts_turn(_turn_cancel, text, tts_lang)
                else:
                    await _speak_full_turn(text, tts_lang, _turn_cancel)

    async def _run_turn(transcript: str, cancel: asyncio.Event, stt_lang: str | None = None):
        nonlocal _last_lang, _current_tts_lang, _tts_aborted_for_retry, _tts_streaming
        if cancel.is_set() or stop_event.is_set() or _is_closing:
            return

        try:
            await _run_turn_body(transcript, cancel, stt_lang)
        finally:
            await _resume_silence_if_waiting()

    async def _run_turn_body(transcript: str, cancel: asyncio.Event, stt_lang: str | None = None):
        nonlocal _last_lang, _current_tts_lang, _tts_aborted_for_retry, _tts_streaming

        lang = llm_module.resolve_response_language(stt_lang, transcript)
        if _last_lang is not None and lang != _last_lang:
            conversation_history.clear()
        _last_lang = lang
        _current_tts_lang = llm_module.tts_code_for_language(lang)
        _tts_aborted_for_retry = False
        _tts_streaming = False

        if workflow_runner.has_graph():
            node = workflow_runner.get_current_node()
            branches = workflow_runner.get_branches()
            node_message = workflow_runner.get_message()

            if node and llm_module.looks_like_farewell(transcript):
                goodbye = llm_module.farewell_message_for_language(lang)
                logger.info(
                    f"[FAREWELL] node={workflow_runner.current_node_id} "
                    f"transcript={transcript!r} message={goodbye!r}"
                )
                await _speak_scripted(goodbye, _current_tts_lang, cancel, hangup_after=True)
                return

            if node and llm_module.looks_like_filler(transcript):
                logger.info(
                    f"[FILLER] ignored node={workflow_runner.current_node_id} "
                    f"transcript={transcript!r}"
                )
                return

            if node and llm_module.looks_like_noise(transcript):
                logger.info(
                    f"[NOISE] ignored node={workflow_runner.current_node_id} "
                    f"transcript={transcript!r}"
                )
                return

            if workflow_runner.is_user_input_node() and node:
                instruction = workflow_runner.get_instruction() or node_message
                if branches:
                    if llm_module.looks_like_acknowledgment(transcript):
                        continue_id = llm_module.find_continue_branch(branches)
                        if continue_id:
                            logger.info(
                                f"[ACK] userInput node={workflow_runner.current_node_id} "
                                f"transcript={transcript!r} branch={continue_id}"
                            )
                            await _advance_and_speak(continue_id, cancel, transcript)
                            return

                    if llm_module.looks_like_factual_question(transcript):
                        await _run_context_qa(transcript, cancel, stt_lang, instruction)
                        return

                    branch_id = await llm_module.classify_branch(
                        transcript, branches, instruction
                    )
                    if branch_id:
                        await _advance_and_speak(branch_id, cancel, transcript)
                        return

                    await _answer_off_script(
                        transcript, cancel, stt_lang, instruction, "userInput"
                    )
                    return

                if llm_module.looks_like_acknowledgment(transcript):
                    logger.info(
                        f"[ACK] userInput node={workflow_runner.current_node_id} "
                        f"transcript={transcript!r}"
                    )
                    await _advance_via_out_and_speak(cancel, transcript)
                    return

                if llm_module.looks_like_factual_question(transcript):
                    await _run_context_qa(transcript, cancel, stt_lang, instruction)
                    return

                await _answer_off_script(
                    transcript, cancel, stt_lang, instruction, "userInput"
                )
                return

            if workflow_runner.is_react_node() and node:
                instruction = workflow_runner.get_instruction() or node_message
                if branches:
                    if llm_module.looks_like_acknowledgment(transcript):
                        continue_id = llm_module.find_continue_branch(branches)
                        if continue_id:
                            logger.info(
                                f"[ACK] react node={workflow_runner.current_node_id} "
                                f"transcript={transcript!r} branch={continue_id}"
                            )
                            await _advance_and_speak(continue_id, cancel, transcript)
                            return

                    if llm_module.looks_like_factual_question(transcript):
                        await _run_context_qa(transcript, cancel, stt_lang, instruction)
                        return

                    branch_id = await llm_module.classify_branch(
                        transcript, branches, instruction
                    )
                    if branch_id:
                        await _advance_and_speak(branch_id, cancel, transcript)
                        return

                    await _answer_off_script(
                        transcript, cancel, stt_lang, instruction, "react"
                    )
                    return

                if llm_module.looks_like_acknowledgment(transcript):
                    logger.info(
                        f"[ACK] react node={workflow_runner.current_node_id} "
                        f"transcript={transcript!r}"
                    )
                    await _advance_via_out_and_speak(cancel, transcript)
                    return

                if llm_module.looks_like_factual_question(transcript):
                    await _run_context_qa(transcript, cancel, stt_lang, instruction)
                    return

                await _answer_off_script(
                    transcript, cancel, stt_lang, instruction, "react"
                )
                return

            if workflow_runner.is_conversation_node() and node and branches:
                if llm_module.looks_like_acknowledgment(transcript):
                    continue_id = llm_module.find_continue_branch(branches)
                    if continue_id:
                        logger.info(
                            f"[ACK] node={workflow_runner.current_node_id} "
                            f"transcript={transcript!r} branch={continue_id}"
                        )
                        await _advance_and_speak(continue_id, cancel, transcript)
                        return

                if llm_module.looks_like_factual_question(transcript):
                    await _run_context_qa(transcript, cancel, stt_lang, node_message)
                    return

                branch_id = await llm_module.classify_branch(transcript, branches, node_message)
                if branch_id:
                    await _advance_and_speak(branch_id, cancel, transcript)
                    return

                await _answer_off_script(
                    transcript, cancel, stt_lang, node_message, "conversation"
                )
                return

            if workflow_runner.is_qa_node() and node:
                if llm_module.looks_like_filler(transcript) or llm_module.looks_like_noise(
                    transcript
                ):
                    logger.info(
                        f"[QA] filler/noise ignored node={workflow_runner.current_node_id} "
                        f"transcript={transcript!r}"
                    )
                    return

                if llm_module.looks_like_negative(transcript):
                    no_branch = workflow_runner.find_no_questions_branch()
                    if no_branch:
                        logger.info(
                            f"[QA] decline node={workflow_runner.current_node_id} "
                            f"transcript={transcript!r} branch={no_branch}"
                        )
                        await _advance_and_speak(no_branch, cancel, transcript)
                        return

                if llm_module.looks_like_factual_question(transcript):
                    await _run_context_qa(transcript, cancel, stt_lang, node_message)
                    return

                if llm_module.looks_like_acknowledgment(transcript):
                    logger.info(
                        f"[QA_REPLAY] node={workflow_runner.current_node_id} "
                        f"transcript={transcript!r}"
                    )
                    if node_message:
                        await _speak_scripted(
                            node_message, _current_tts_lang, cancel, hangup_after=False
                        )
                    return

                if branches:
                    branch_id = await llm_module.classify_branch(
                        transcript, branches, node_message
                    )
                    if branch_id:
                        await _advance_and_speak(branch_id, cancel, transcript)
                        return

                await _answer_off_script(
                    transcript, cancel, stt_lang, node_message, "qa"
                )
                return

            if branches and node:
                branch_id = await llm_module.classify_branch(transcript, branches, node_message)
                if branch_id:
                    await _advance_and_speak(branch_id, cancel, transcript)
                    return

            if node:
                logger.info(
                    f"[UNHANDLED] node={workflow_runner.current_node_id} "
                    f"transcript={transcript!r}"
                )
                return

        system_prompt = llm_module.build_system_prompt(
            base_context, base_example, voice_session.end_points
        )

        async def on_language_retry():
            nonlocal _tts_aborted_for_retry, _tts_streaming
            _tts_aborted_for_retry = True
            _tts_streaming = False
            await tts_session.abort()
            _schedule_tts_prewarm(_current_tts_lang, after_abort=True)

        try:
            await llm_module.stream_llm_response(
                transcript=transcript,
                conversation_history=conversation_history,
                event_callback=on_event,
                cancel_event=cancel,
                stt_lang=stt_lang,
                on_language_retry=on_language_retry,
                system_prompt=system_prompt,
            )
        except asyncio.CancelledError:
            _tts_streaming = False
        except Exception as e:
            logger.error(f"[TURN ERROR] {e}")

    async def _run_greeting():
        nonlocal _greeting_active
        try:
            logger.info(f"[GREETING] Playing: {greeting!r}")
            await call_logger.start_ai_turn(node_id=workflow_runner.current_node_id)
            await _send({"type": "greeting_start", "text": greeting})
            await _speak_full_turn(greeting, "en-IN", _turn_cancel, cancellable=False)
            await call_logger.log_event("greeting_end", payload={"text": greeting})
        except Exception as e:
            logger.error(f"[GREETING] Failed: {e}")
        finally:
            _greeting_active = False
            await _send({"type": "greeting_end"})
            _schedule_tts_prewarm("en-IN")

    async def _session_startup():
        try:
            await tts_session.prewarm("en-IN")
            await _run_greeting()
        except Exception as e:
            logger.error(f"[SESSION STARTUP] {e}")
            _greeting_active = False
            await _send({"type": "greeting_end"})

    async def handle_client_interrupt():
        nonlocal _caller_listening
        if _is_closing or _greeting_active:
            return

        await call_logger.flush_ai_interrupted()
        await call_logger.log_event("client_interrupt", node_id=workflow_runner.current_node_id)

        _tts_streaming = False
        await _abort_tts()
        _schedule_tts_prewarm(_current_tts_lang, after_abort=True)

        if _active_tasks:
            _interrupt()
            await _send({"type": "interrupted"})
            _start_new_turn()
            _transcript_buffer.clear()

        _caller_listening = True
        logger.info("[LISTENING] Caller ready after barge-in")

    async def handle_tts_playback_done():
        if _is_closing or stop_event.is_set():
            return
        await _on_caller_ready()

    stt_task = asyncio.create_task(run_streaming_stt(audio_queue, on_event, stop_event))
    asyncio.create_task(_session_startup())

    try:
        while True:
            message = await websocket.receive()

            if "bytes" in message and message["bytes"]:
                if _is_closing or not _caller_listening:
                    continue
                data = message["bytes"]
                try:
                    audio_queue.put_nowait(data)
                except asyncio.QueueFull:
                    try:
                        audio_queue.get_nowait()
                        audio_queue.put_nowait(data)
                    except Exception:
                        pass

            elif "text" in message and message["text"]:
                try:
                    payload = json.loads(message["text"])
                    if payload.get("type") == "client_interrupt":
                        await handle_client_interrupt()
                    elif payload.get("type") == "tts_playback_done":
                        await handle_tts_playback_done()
                except Exception as e:
                    logger.debug(f"[TEXT MSG PARSE ERROR] {e}")

    except WebSocketDisconnect:
        logger.info("[CLIENT DISCONNECTED]")
    except Exception as e:
        logger.error(f"[ERROR] {e}")
    finally:
        stop_event.set()
        _interrupt()
        await tts_session.close()
        await audio_queue.put(None)
        try:
            await asyncio.wait_for(stt_task, timeout=3.0)
        except asyncio.TimeoutError:
            stt_task.cancel()
        logger.info("[SESSION CLOSED]")
