"""
stt.py — fixed message parsing based on live SDK output.

Sarvam SDK returns objects, not dicts:
  type='events'  → data.signal_type = 'START_SPEECH' | 'END_SPEECH'
  type='data'    → data.transcript  = 'transcribed text'
"""

import asyncio
import base64
import logging
import os

from sarvamai import AsyncSarvamAI

logger = logging.getLogger("stt")

SARVAM_API_KEY = os.environ.get("SARVAM_API_KEY", "")
SEND_CHUNK_BYTES = 4096

# STT config (env-overridable so we can retune without a rebuild).
#   STT_LANGUAGE_CODE — "unknown" for auto-detect, or a concrete code like
#                       "en-IN" / "hi-IN" if auto-detect yields no transcripts.
#   STT_HIGH_VAD      — "1" (default) uses Sarvam's snappy 0.5s silence
#                       boundary recommended for conversational agents.
STT_LANGUAGE_CODE = os.environ.get("STT_LANGUAGE_CODE", "unknown").strip() or "unknown"
STT_HIGH_VAD = os.environ.get("STT_HIGH_VAD", "1").strip().lower() in ("1", "true", "yes")

# Log the raw message type for the first N frames of each session so we can
# see exactly what Sarvam sends back (or that it sends nothing at all).
_RAW_MSG_LOG_LIMIT = 20

_stt_fields_logged = False


def _extract_is_final(data) -> bool | None:
    """Best-effort final/interim flag from Sarvam STT data object."""
    for attr in ("is_final", "final", "is_partial"):
        val = getattr(data, attr, None)
        if val is not None:
            if attr == "is_partial":
                return not bool(val)
            return bool(val)
    return None


def _close_details(exc: BaseException) -> str:
    """Extract WebSocket close code + reason if present (auth/quota = 4xxx)."""
    code = getattr(exc, "code", None)
    reason = getattr(exc, "reason", None)
    if code is None:
        rcvd = getattr(exc, "rcvd", None)
        if rcvd is not None:
            code = getattr(rcvd, "code", None)
            reason = getattr(rcvd, "reason", None)
    if code is not None:
        return f"close_code={code} reason={reason!r}"
    return f"{type(exc).__name__}: {exc}"


async def run_streaming_stt(
    audio_queue: asyncio.Queue,
    event_callback,
    stop_event: asyncio.Event,
):
    global _stt_fields_logged
    if not SARVAM_API_KEY:
        logger.error("[SARVAM] SARVAM_API_KEY not set — STT disabled")
        return

    client = AsyncSarvamAI(api_subscription_key=SARVAM_API_KEY)

    logger.info(
        f"[SARVAM] Connecting model=saaras:v3 mode=transcribe "
        f"language_code={STT_LANGUAGE_CODE} sample_rate=16000 "
        f"codec=pcm_s16le high_vad={STT_HIGH_VAD} vad_signals=True"
    )

    try:
        async with client.speech_to_text_streaming.connect(
            model="saaras:v3",
            mode="transcribe",
            language_code=STT_LANGUAGE_CODE,
            sample_rate=16000,
            input_audio_codec="pcm_s16le",
            high_vad_sensitivity=STT_HIGH_VAD,
            vad_signals=True,
        ) as sarvam_ws:

            logger.info("[SARVAM] Connection established")

            async def sender():
                buf = bytearray()
                chunks_sent = 0
                bytes_sent = 0
                try:
                    while not stop_event.is_set():
                        try:
                            chunk = await asyncio.wait_for(audio_queue.get(), timeout=0.1)
                        except asyncio.TimeoutError:
                            continue

                        if chunk is None:
                            break

                        buf.extend(chunk)

                        while len(buf) >= SEND_CHUNK_BYTES:
                            payload = bytes(buf[:SEND_CHUNK_BYTES])
                            buf = buf[SEND_CHUNK_BYTES:]
                            b64 = base64.b64encode(payload).decode("utf-8")
                            await sarvam_ws.transcribe(
                                audio=b64,
                                encoding="audio/wav",
                                sample_rate=16000,
                            )
                            chunks_sent += 1
                            bytes_sent += len(payload)
                            if chunks_sent % 10 == 1:
                                logger.info(f"[SARVAM] Sent chunk #{chunks_sent}")
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"[SARVAM] Sender error: {_close_details(e)}")
                finally:
                    secs = bytes_sent / (16000 * 2) if bytes_sent else 0.0
                    logger.info(
                        f"[SARVAM] Sender done. Total: {chunks_sent} chunks "
                        f"({bytes_sent} bytes ≈ {secs:.1f}s audio)"
                    )

            async def receiver():
                global _stt_fields_logged
                raw_logged = 0
                exit_reason = "stream ended"
                logger.info("[SARVAM] Receiver started")
                try:
                    async for msg in sarvam_ws:
                        if stop_event.is_set():
                            exit_reason = "stop_event set"
                            break

                        msg_type = getattr(msg, "type", "")

                        if raw_logged < _RAW_MSG_LOG_LIMIT:
                            logger.info(f"[SARVAM RAW] type={msg_type!r} msg={msg!r}")
                            raw_logged += 1

                        data = getattr(msg, "data", None)

                        if msg_type == "events" and data is not None:
                            signal = getattr(data, "signal_type", "")
                            if signal == "START_SPEECH":
                                logger.info("[SPEECH START]")
                                await event_callback("speech_start", "")
                            elif signal == "END_SPEECH":
                                logger.info("[SPEECH END]")
                                await event_callback("speech_end", "")
                            else:
                                logger.warning(f"[SARVAM] Unknown signal_type={signal!r}")

                        elif msg_type == "data" and data is not None:
                            if not _stt_fields_logged:
                                logger.info(
                                    f"[STT DATA FIELDS] is_final={_extract_is_final(data)} "
                                    f"lang={getattr(data, 'language_code', None)}"
                                )
                                _stt_fields_logged = True

                            transcript = getattr(data, "transcript", "") or ""
                            if transcript:
                                detected_lang = getattr(data, "language_code", None)
                                is_final = _extract_is_final(data)
                                if detected_lang:
                                    logger.info(f"USER [{detected_lang}]: {transcript}")
                                else:
                                    logger.info(f"USER: {transcript}")
                                await event_callback(
                                    "transcript", transcript, detected_lang, is_final=is_final
                                )
                            else:
                                logger.info("[SARVAM] Empty transcript frame")

                        elif msg_type == "error":
                            logger.error(f"[SARVAM] Error frame: {msg!r}")

                        else:
                            logger.warning(f"[SARVAM UNKNOWN] type={msg_type!r} {msg!r}")
                except asyncio.CancelledError:
                    exit_reason = "cancelled"
                    raise
                except Exception as e:
                    exit_reason = _close_details(e)
                    logger.error(f"[SARVAM] Receiver error: {exit_reason}")
                finally:
                    logger.info(f"[SARVAM] Receiver done (reason={exit_reason})")

            results = await asyncio.gather(
                sender(), receiver(), return_exceptions=True
            )
            for name, result in zip(("sender", "receiver"), results):
                if isinstance(result, Exception):
                    logger.error(f"[SARVAM] {name} raised: {_close_details(result)}")
    except Exception as e:
        logger.error(f"[SARVAM] Connection failed: {_close_details(e)}")
