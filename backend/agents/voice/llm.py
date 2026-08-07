"""
llm.py
- Model: sarvam-m
- Dynamic system prompt from workflow sessions
- cancel_event for interrupt support
"""

import asyncio
import json
import logging
import os
import re

import httpx

logger = logging.getLogger("llm")

SARVAM_API_KEY = os.environ.get("SARVAM_API_KEY", "")
SARVAM_CHAT_URL = "https://api.sarvam.ai/v1/chat/completions"
LLM_MODEL = "sarvam-105b"

_http_client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0),
    headers={
        "Authorization": f"Bearer {SARVAM_API_KEY}",
        "api-subscription-key": SARVAM_API_KEY,
        "Content-Type": "application/json",
    }
)

FALLBACK_EN = "We'll get back to you on that."
FALLBACK_HI = "हम इस बारे में आपको वापस बताएंगे।"
FALLBACK_HINGLISH = "Iske baare mein hum aapko wapas bata denge."

FAREWELL_EN = "Okay, goodbye."
FAREWELL_HI = "ठीक है, नमस्कार।"
FAREWELL_HINGLISH = "Theek hai, bye."

_DEVANAGARI = re.compile(r"[\u0900-\u097F]")
_HINGLISH_MARKERS = re.compile(
    r"\b(kya|kahan|kab|hai|hain|mein|hoga|hogi|nahi|haan|subah|shaam|bataiye|batao|bata|batana|bataye|baj|baje|ko|ka|ki|ke)\b",
    re.I,
)

LANG_INSTRUCTIONS = {
    "english": (
        "[Reply ONLY in English. Use Latin script only. "
        "No Devanagari. No Hindi words like ko, subah, baje, hai, mein.]"
    ),
    "hindi": (
        "[Reply ONLY in Hindi Devanagari. ONE sentence, max 20 words. "
        "No English words except proper nouns.]"
    ),
    "hinglish": (
        "[Reply ONLY in Hinglish — Roman script mix of Hindi and English. "
        "No Devanagari characters.]"
    ),
}

RETRY_INSTRUCTIONS = {
    "english": (
        "[CRITICAL: Your answer MUST be 100% English in Latin script. "
        "Zero Devanagari. Zero Hindi words.]"
    ),
    "hindi": (
        "[CRITICAL: Your answer MUST be 100% Hindi in Devanagari script only. "
        "ONE sentence, max 20 words.]"
    ),
    "hinglish": (
        "[CRITICAL: Your answer MUST be Hinglish in Roman script only. "
        "Mix Hindi and English naturally. No Devanagari.]"
    ),
}


def build_system_prompt(context: str, example: str, end_points: list[str]) -> str:
    end_block = ", ".join(end_points) if end_points else "conversation complete, user says goodbye"
    return f"""You are Susha, an AI voice agent on a phone call. Follow the persona and workflow below.

Answer immediately and briefly.
ONE sentence only. Maximum 20 words. No thinking. No explanation. Just the answer.

LANGUAGE — highest priority: mirror the user's language exactly.
- English question → reply in English ONLY (Latin script, no Devanagari, no Hindi words)
- Hindi question → reply in Hindi ONLY (Devanagari script)
- Hinglish question → reply in Hinglish ONLY (Roman script mix of Hindi + English, no Devanagari)
Never switch language unless the user does.
If you don't know the answer, say "We'll get back to you on that." in the user's language.

IDENTITY:
- You are Susha (agent). NEVER address the caller as Susha.
- Caller name is CALLER_NAME / CONTACT DATA "name" from Excel. Use that only.
- If asked the caller's name and it is UNKNOWN/missing, say you don't have it — never answer "Susha".

CONTEXT (what you can do and who you represent):
{context.strip() or "You are a helpful voice assistant for this business."}

EXAMPLE CONVERSATION FLOW (use as a guide — adapt naturally to the caller):
{example.strip() or "AI: Hello! How can I help you today?"}

END POINTS — when the conversation naturally reaches one of these outcomes, give a brief polite closing goodbye:
{end_block}

When the user indicates they are done, or their intent matches an end point, respond with a short goodbye."""


def build_node_fallback_prompt(
    context: str,
    node_title: str,
    node_message: str,
) -> str:
    facts = context.strip() or "You are a helpful voice assistant for this business."
    return f"""You are Susha, an AI voice agent on a live phone call. Follow the persona and facts below.

Answer immediately and briefly.
ONE sentence only. Maximum 20 words. No thinking. No explanation. Just the answer.

LANGUAGE — highest priority: mirror the user's language exactly.
- English → Latin script only
- Hindi → Devanagari only
- Hinglish → Roman script mix, no Devanagari

FACTS — answer ONLY from this block. Do not invent amounts or dates:
{facts}

CURRENT WORKFLOW STEP: "{node_title}"
You just asked the caller: "{node_message}"

RULES:
- You are Susha (the agent). NEVER address the caller as Susha.
- Caller name is the CONTACT DATA / CALLER_NAME field only. Use that name if you must address them.
- If asked the caller's name, answer CALLER_NAME only. Never say their name is Susha.
- The caller asked a question NOT covered by yes/no branch choices.
- Answer ONLY the specific question asked — one fact, one sentence.
- Do NOT repeat or summarize the full event/call details already shared.
- If the fact exists (amount, fine, date, name), state it clearly in one sentence.
- If the fact is NOT in FACTS, say "We'll get back to you on that."
- Use CONTACT DATA fields when they answer the question.
- Do NOT repeat workflow branch labels or examples.
- Do NOT speak as the caller (never say "I will pay…").
- Do NOT end the call or say goodbye.
- After answering, ask only: "Any other questions?" — nothing else."""


async def _post_chat(messages: list, max_tokens: int = 80) -> str:
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.1,
        "stream": False,
        "reasoning_effort": None,
    }
    response = await _http_client.post(SARVAM_CHAT_URL, json=payload)
    if response.status_code != 200:
        logger.error(f"[LLM] HTTP {response.status_code}: {response.text}")
        return ""
    data = response.json()
    raw = data["choices"][0]["message"].get("content", "") or ""
    return _strip_think(raw)


_OFF_SCRIPT_QUESTION = re.compile(
    r"(?:^|\s)(?:how\s+much|how\s+many|how\s+do|how\s+can|how\s+is|how\s+are|"
    r"what|when|where|why|who|which|tell\s+me|explain|"
    r"amount|fine|penalty|remaining|balance|total|cost|rupees|"
    r"list|missing|repeat|again|item|items|order|delivery|address|include|name|"
    r"kitna|kitne|kya|kab|kahan|kaise|jurmana|baaki|shulk)\b",
    re.I,
)

_FAREWELL = re.compile(
    r"(?:^|\b)(?:"
    r"bye|good\s*bye|goodbye|see\s+ya|see\s+you(?:\s+later)?|"
    r"thanks?\s+bye|thank\s+you\s+bye|ok(?:ay)?\s+bye|that's\s+all|"
    r"alvida|chalo\s+bye|dhanyavaad|dhanyawad"
    r")(?:\b|$)",
    re.I,
)


def _normalize_transcript(transcript: str) -> str:
    text = re.sub(r"[^\w\s']", " ", transcript.strip().lower())
    return re.sub(r"\s+", " ", text).strip()


_FILLER_ONLY = re.compile(
    r"^(?:umm+|uhh*|uh+|hmm+|hm+|ahh*|ah+|er+|mm+|a+h+|u+h+)$",
    re.I,
)

_ACK_ONLY = re.compile(
    r"^(?:ok(?:ay)?|alright|all\s+right|sure|got\s+it|i\s+see|right|"
    r"theek(?:\s+hai)?|achha+|haan|ji)$",
    re.I,
)

_ACK_EXCLUDE = re.compile(
    r"\b(?:pay|will|won't|wont|don't|dont|no|yes|what|how|when|where|why|if|but)\b",
    re.I,
)

_NEGATIVE_ONLY = re.compile(
    r"^(?:no(?:pe)?|nothing|none|that's\s+all|thats\s+all|"
    r"no\s+questions?|don't\s+have\s+(?:any\s+)?questions?|"
    r"dont\s+have\s+(?:any\s+)?questions?|nahi|nah|busy|later|not\s+now)$",
    re.I,
)

_REFUSE_TALK = re.compile(
    r"(?:^|\b)(?:"
    r"don'?t\s+want\s+to\s+(?:talk|speak|continue)|"
    r"do\s+not\s+want\s+to\s+(?:talk|speak)|"
    r"not\s+interested|"
    r"stop\s+calling|"
    r"don'?t\s+call|"
    r"remove\s+(?:my\s+)?(?:number|name)|"
    r"baat\s+nahi\s+karni|"
    r"nahi\s+karna\s+(?:chahta|chahti)|"
    r"mat\s+call"
    r")(?:\b|$)",
    re.I,
)

_POSITIVE_ONLY = re.compile(
    r"^(?:yes|yeah|yep|yup|sure|ok|okay|haan|ha|ji|correct|right)$",
    re.I,
)

_CONTINUE_BRANCH_IDS = frozenset({"continue", "ack", "default", "next"})


def looks_like_farewell(transcript: str) -> bool:
    text = _normalize_transcript(transcript)
    if not text:
        return False
    return bool(_FAREWELL.search(text))


def looks_like_filler(transcript: str) -> bool:
    text = _normalize_transcript(transcript)
    if not text:
        return False
    return bool(_FILLER_ONLY.match(text))


def looks_like_acknowledgment(transcript: str) -> bool:
    text = _normalize_transcript(transcript)
    if not text:
        return False
    if looks_like_farewell(text) or looks_like_filler(text):
        return False
    if len(text.split()) >= 3:
        return False
    if _ACK_EXCLUDE.search(text):
        return False
    return bool(_ACK_ONLY.match(text))


def looks_like_negative(transcript: str) -> bool:
    text = _normalize_transcript(transcript)
    if not text:
        return False
    if looks_like_farewell(text) or looks_like_filler(text):
        return False
    return bool(_NEGATIVE_ONLY.match(text))


def looks_like_refuse_talk(transcript: str) -> bool:
    """Caller does not want to continue the call at all."""
    text = _normalize_transcript(transcript)
    if not text:
        return False
    if looks_like_farewell(text):
        return False
    return bool(_REFUSE_TALK.search(text))


def looks_like_positive(transcript: str) -> bool:
    text = _normalize_transcript(transcript)
    if not text:
        return False
    if looks_like_farewell(text) or looks_like_filler(text):
        return False
    if len(text.split()) >= 3:
        return False
    return bool(_POSITIVE_ONLY.match(text))


def match_branch_local(transcript: str, branches: list[dict]) -> str | None:
    """Fast path: match branch examples / yes-no without an LLM round-trip."""
    text = _normalize_transcript(transcript)
    if not text or not branches:
        return None

    by_example: list[str] = []
    for branch in branches:
        bid = (branch.get("id") or "").strip()
        if not bid:
            continue
        for raw_ex in branch.get("examples") or []:
            ex = _normalize_transcript(str(raw_ex))
            if not ex:
                continue
            if text == ex or text.startswith(ex + " "):
                by_example.append(bid)
                break

    if len(by_example) == 1:
        return by_example[0]

    if looks_like_positive(text):
        for branch in branches:
            bid = (branch.get("id") or "").strip()
            if not bid:
                continue
            suffix = bid.rsplit("-", 1)[-1].lower()
            label = (branch.get("label") or "").strip().lower()
            if suffix == "yes" or label == "yes":
                return bid

    if looks_like_negative(text):
        for branch in branches:
            bid = (branch.get("id") or "").strip()
            if not bid:
                continue
            suffix = bid.rsplit("-", 1)[-1].lower()
            label = (branch.get("label") or "").strip().lower()
            if suffix == "no" or label == "no":
                return bid

    return None


def looks_like_noise(transcript: str) -> bool:
    stripped = transcript.strip()
    if not stripped:
        return True
    if looks_like_filler(stripped):
        return True
    if re.match(r"^[\W_]+$", stripped, re.UNICODE):
        return True

    text = _normalize_transcript(stripped)
    if not text:
        core = re.sub(r"[^\w]", "", stripped, flags=re.UNICODE)
        if core and len(core) <= 2:
            if not looks_like_acknowledgment(stripped) and not looks_like_negative(stripped):
                return True
        return len(stripped) <= 3

    if looks_like_acknowledgment(stripped) or looks_like_negative(stripped):
        return False

    words = text.split()
    if len(words) == 1 and len(words[0]) <= 2:
        if re.match(r"^[a-z]{1,2}$", words[0], re.I):
            return True
        if re.search(r"[^\x00-\x7F]", words[0]):
            return True
    return False


def find_continue_branch(branches: list[dict]) -> str | None:
    for branch in branches:
        bid = (branch.get("id") or "").strip()
        if not bid:
            continue
        suffix = bid.rsplit("-", 1)[-1]
        if bid in _CONTINUE_BRANCH_IDS or suffix in _CONTINUE_BRANCH_IDS:
            return bid
    return None


def looks_like_factual_question(transcript: str) -> bool:
    return _looks_like_off_script(transcript)


def farewell_message_for_language(lang: str) -> str:
    return {
        "english": FAREWELL_EN,
        "hindi": FAREWELL_HI,
        "hinglish": FAREWELL_HINGLISH,
    }.get(lang, FAREWELL_EN)


def _looks_like_off_script(transcript: str) -> bool:
    text = transcript.strip()
    if not text:
        return False
    if (
        looks_like_farewell(text)
        or looks_like_filler(text)
        or looks_like_noise(text)
        or looks_like_acknowledgment(text)
    ):
        return False
    if "?" in text:
        return True
    return bool(_OFF_SCRIPT_QUESTION.search(text))


def _extract_json_object(raw: str) -> dict | None:
    raw = raw.strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None


def _parse_branch_id(raw: str, valid_ids: set[str]) -> str | None:
    parsed = _extract_json_object(raw)
    if not parsed:
        return None

    confidence = (parsed.get("confidence") or "high").lower()
    if confidence != "high":
        return None

    bid = parsed.get("branchId")
    if bid and bid in valid_ids:
        return bid
    return None


async def classify_branch(
    transcript: str,
    branches: list[dict],
    node_message: str,
) -> str | None:
    if not branches:
        return None

    if looks_like_farewell(transcript):
        logger.info(f"[CLASSIFY] farewell pre-check → null for {transcript!r}")
        return None

    if looks_like_filler(transcript):
        logger.info(f"[CLASSIFY] filler pre-check → null for {transcript!r}")
        return None

    if looks_like_noise(transcript):
        logger.info(f"[CLASSIFY] noise pre-check → null for {transcript!r}")
        return None

    local = match_branch_local(transcript, branches)
    if local:
        logger.info(f"[CLASSIFY] local match transcript={transcript!r} → branch={local!r}")
        return local

    valid_ids = {b["id"] for b in branches}
    branch_lines = []
    for b in branches:
        examples = b.get("examples") or []
        ex_str = f" examples={examples}" if examples else ""
        branch_lines.append(f'- id="{b["id"]}" label="{b.get("label", "")}"{ex_str}')

    system = (
        "You classify whether the user is CHOOSING one of the listed branch options "
        "(multiple-choice answers), not asking a new question.\n\n"
        "Match ONLY when the user clearly picks a branch: confirming, refusing, agreeing to pay, "
        "declining a date, saying they have no time, etc.\n\n"
        "Return {\"branchId\": null, \"confidence\": \"high\"} when the user:\n"
        "- Asks a question (amount, date, details, clarification)\n"
        "- Changes topic without picking a branch\n"
        "- Gives a partial or ambiguous reply\n"
        "- Makes unclear vocalizations (ah, uh, single syllables, one-letter sounds)\n\n"
        "Do NOT match because the user mentions a word that appears in a branch label.\n"
        "Single-syllable vocalizations or unclear sounds → {\"branchId\": null, \"confidence\": \"high\"}.\n"
        "Only match no-questions when the user clearly says no / nothing / that's all.\n"
        "Bare acknowledgments with NO commitment intent (okay, ok, alright, got it, understood) "
        "→ match the continue branch if one exists, NOT pay/yes branches.\n"
        "Payment or yes branches require explicit commitment "
        '(e.g. "I will pay", "ok I will pay", "yes I\'ll pay tomorrow").\n\n'
        'Example: "how much is the payment?" → {"branchId": null, "confidence": "high"}\n'
        'Example: "okay" or "alright" alone → continue branch if listed, else null\n'
        'Example: "yes i will pay on the 10th" → {"branchId": "reminder-r-pay", "confidence": "high"}\n'
        'Example: "no i dont have time" → {"branchId": "intro-r-no", "confidence": "high"}\n\n'
        'Reply with JSON only: {"branchId": "<id>"|null, "confidence": "high"|"low"}'
    )
    user = (
        f"AI asked: {node_message}\n"
        f"User said: {transcript}\n\n"
        f"Branches:\n" + "\n".join(branch_lines)
    )

    raw = await _post_chat(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        max_tokens=80,
    )
    branch_id = _parse_branch_id(raw, valid_ids)
    logger.info(f"[CLASSIFY] transcript={transcript!r} → branch={branch_id!r} raw={raw!r}")
    return branch_id


def resolve_response_language(stt_lang: str | None, transcript: str) -> str:
    if _DEVANAGARI.search(transcript):
        return "hindi"
    if _HINGLISH_MARKERS.search(transcript):
        return "hinglish"
    if stt_lang == "hi-IN":
        return "hindi"
    return "english"


def tts_code_for_language(lang: str) -> str:
    return "en-IN" if lang == "english" else "hi-IN"


def output_matches_language(text: str, lang: str) -> bool:
    has_dev = bool(_DEVANAGARI.search(text))
    has_roman_hindi = bool(_HINGLISH_MARKERS.search(text))
    if lang == "english":
        return not has_dev and not has_roman_hindi
    if lang == "hindi":
        return has_dev and not has_roman_hindi
    if lang == "hinglish":
        return not has_dev
    return True


def _strip_think(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    return re.sub(r"<think>.*", "", text, flags=re.DOTALL).strip()


async def _complete_once(
    messages: list,
    cancel_event: asyncio.Event,
    event_callback,
    stream_tokens: bool,
    *,
    max_tokens: int = 120,
) -> str:
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "stream": stream_tokens,
        "reasoning_effort": None,
    }

    if not stream_tokens:
        response = await _http_client.post(SARVAM_CHAT_URL, json=payload)
        if response.status_code != 200:
            logger.error(f"[LLM] HTTP {response.status_code}: {response.text}")
            return ""
        data = response.json()
        raw = data["choices"][0]["message"].get("content", "") or ""
        return _strip_think(raw)

    full_text = ""
    emitted = ""

    async with _http_client.stream("POST", SARVAM_CHAT_URL, json=payload) as response:
        if response.status_code != 200:
            body = await response.aread()
            logger.error(f"[LLM] HTTP {response.status_code}: {body.decode()}")
            return ""

        async for raw_line in response.aiter_lines():
            if cancel_event.is_set():
                return ""

            if not raw_line or not raw_line.startswith("data:"):
                continue

            data_str = raw_line[5:].strip()
            if data_str == "[DONE]":
                break

            try:
                chunk = json.loads(data_str)
                token = chunk["choices"][0].get("delta", {}).get("content", "") or ""
                if not token:
                    continue

                full_text += token
                in_think = full_text.count("<think>") > full_text.count("</think>")
                if in_think:
                    continue

                cleaned = _strip_think(full_text)
                new_part = cleaned[len(emitted):]
                if new_part:
                    await event_callback("llm_token", new_part)
                    emitted = cleaned
            except Exception as e:
                logger.debug(f"[LLM PARSE ERROR] {e}")

    return _strip_think(full_text)


async def stream_llm_response(
    transcript: str,
    conversation_history: list,
    event_callback,
    cancel_event: asyncio.Event = None,
    stt_lang: str | None = None,
    on_language_retry=None,
    system_prompt: str | None = None,
):
    if cancel_event is None:
        cancel_event = asyncio.Event()

    prompt = system_prompt or build_system_prompt("", "", [])
    response_language = resolve_response_language(stt_lang, transcript)
    logger.info(f"[LLM] response_language={response_language} stt_lang={stt_lang!r}")

    instruction = LANG_INSTRUCTIONS[response_language]
    user_content = f"{instruction}\n{transcript}"

    messages = [
        {"role": "system", "content": prompt},
        *conversation_history,
        {"role": "user", "content": user_content},
    ]

    await event_callback("llm_start", "")

    try:
        final_text = await _complete_once(messages, cancel_event, event_callback, stream_tokens=True)
    except asyncio.CancelledError:
        logger.info("[LLM] CancelledError — interrupted")
        return
    except Exception as e:
        logger.error(f"[LLM] {e}")
        await event_callback("llm_error", str(e))
        return

    if cancel_event.is_set():
        return

    if final_text and not output_matches_language(final_text, response_language):
        logger.warning(
            f"[LLM] Language mismatch (wanted {response_language}): {final_text[:80]!r} — retrying"
        )
        if on_language_retry:
            await on_language_retry()
        retry_content = f"{RETRY_INSTRUCTIONS[response_language]}\n{transcript}"
        retry_messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": retry_content},
        ]
        try:
            retry_text = await _complete_once(retry_messages, cancel_event, event_callback, stream_tokens=False)
            if retry_text and output_matches_language(retry_text, response_language):
                final_text = retry_text
            else:
                logger.warning(f"[LLM] Retry still mismatched: {retry_text[:80]!r}")
        except Exception as e:
            logger.error(f"[LLM] Retry failed: {e}")

    if not final_text:
        logger.warning("[LLM] No answer — using fallback")
        fallbacks = {"english": FALLBACK_EN, "hindi": FALLBACK_HI, "hinglish": FALLBACK_HINGLISH}
        final_text = fallbacks.get(response_language, FALLBACK_EN)

    conversation_history.append({"role": "user", "content": transcript})
    conversation_history.append({"role": "assistant", "content": final_text})
    conversation_history[:] = conversation_history[-20:]

    logger.info(f"AI: {final_text}")
    await event_callback("llm_end", final_text, response_language)


async def prefetch_context_tell_text(
    context: str,
    instruction: str,
    node_title: str,
    node_id: str | None = None,
) -> str:
    """Pre-generate info-block text (no TTS) while caller thinks."""
    prompt = build_context_tell_prompt(context, instruction, node_title)
    response_language = resolve_response_language(None, instruction)
    instruction_lang = LANG_INSTRUCTIONS[response_language]
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": f"{instruction_lang}\nFulfill the task using FACTS only."},
    ]
    cancel = asyncio.Event()
    try:
        text = await _complete_once(
            messages, cancel, _noop_event_callback, stream_tokens=False, max_tokens=180
        )
    except Exception as e:
        logger.debug(f"[CONTEXT_TELL_PREFETCH] node={node_id} failed: {e}")
        return ""
    if text:
        logger.info(f"[CONTEXT_TELL_PREFETCH] node={node_id} ready len={len(text)}")
    return text.strip()


async def _noop_event_callback(*_args, **_kwargs):
    pass


def build_context_tell_prompt(
    context: str,
    instruction: str,
    node_title: str,
) -> str:
    facts = context.strip() or "You are a helpful voice assistant for this business."
    task = instruction.strip() or "Tell the caller all relevant details from the facts."
    return f"""You are Susha, an AI voice agent on a live phone call. Follow the persona and facts below.

Speak immediately and clearly like a human on the phone.
2 to 5 short spoken sentences. Maximum 80 words. No thinking. No explanation.

LANGUAGE — highest priority: use English in Latin script unless facts specify otherwise.
- English → Latin script only
- Hindi → Devanagari only
- Hinglish → Roman script mix, no Devanagari

FACTS — use ONLY this block. Do not invent amounts or dates:
{facts}

CURRENT WORKFLOW STEP: "{node_title}"

YOUR TASK:
{task}

RULES:
- You are Susha (the agent). NEVER address or greet the caller as Susha.
- Caller name is ONLY the CONTACT DATA / CALLER_NAME value. Address them by that name (e.g. "Atul, …"). If name is missing or UNKNOWN, do not invent one and never use Susha.
- If asked "what is my name?", answer CALLER_NAME from CONTACT DATA only. If UNKNOWN, say you don't have their name on file — never say Susha.
- Speak in natural sentences only. Do NOT use bullet lists, line breaks as a list, or labels like "Event:", "Date:", "Place:", "Topics:".
- Do NOT mention word limits, prompts, FACTS, CONTACT DATA, system instructions, or that you covered all facts.
- Do NOT say "we'll get back to you" unless a specific fact the caller needs is missing from FACTS.
- Proactively tell the caller the call details using ONLY the FACTS block, woven into spoken sentences.
- Use every relevant CONTACT DATA field (loan amounts, installments, dates, etc.) when present.
- Do NOT ask if they will attend unless the task explicitly says to.
- Do NOT repeat company name, reason, or intro wording.
- Do NOT speak as the caller.
- Do NOT end the call or say goodbye."""


async def stream_context_tell(
    context: str,
    instruction: str,
    node_title: str,
    event_callback,
    cancel_event: asyncio.Event = None,
    stt_lang: str | None = None,
    on_language_retry=None,
    node_id: str | None = None,
) -> str:
    """Proactively speak facts from CONTEXT per block instruction — on node entry."""
    if cancel_event is None:
        cancel_event = asyncio.Event()

    prompt = build_context_tell_prompt(context, instruction, node_title)
    response_language = resolve_response_language(stt_lang, instruction)
    logger.info(
        f"[CONTEXT_TELL] node={node_id} instruction={instruction!r} lang={response_language}"
    )

    instruction_lang = LANG_INSTRUCTIONS[response_language]
    user_content = f"{instruction_lang}\nFulfill the task using FACTS only."

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": user_content},
    ]

    await event_callback("llm_start", "")

    try:
        final_text = await _complete_once(
            messages, cancel_event, event_callback, stream_tokens=True, max_tokens=180
        )
    except asyncio.CancelledError:
        logger.info("[CONTEXT_TELL] CancelledError — interrupted")
        return ""
    except Exception as e:
        logger.error(f"[CONTEXT_TELL] {e}")
        await event_callback("llm_error", str(e))
        return ""

    if cancel_event.is_set():
        return ""

    if final_text and not output_matches_language(final_text, response_language):
        logger.warning(
            f"[CONTEXT_TELL] Language mismatch (wanted {response_language}): {final_text[:80]!r} — retrying"
        )
        if on_language_retry:
            await on_language_retry()
        retry_content = f"{RETRY_INSTRUCTIONS[response_language]}\nFulfill the task using FACTS only."
        retry_messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": retry_content},
        ]
        try:
            retry_text = await _complete_once(retry_messages, cancel_event, event_callback, stream_tokens=False)
            if retry_text and output_matches_language(retry_text, response_language):
                final_text = retry_text
        except Exception as e:
            logger.error(f"[CONTEXT_TELL] Retry failed: {e}")

    if not final_text:
        fallbacks = {"english": FALLBACK_EN, "hindi": FALLBACK_HI, "hinglish": FALLBACK_HINGLISH}
        final_text = fallbacks.get(response_language, FALLBACK_EN)

    logger.info(f"[CONTEXT_TELL] node={node_id} spoken={final_text!r}")
    await event_callback("llm_end", final_text, response_language)
    return final_text


def build_context_react_prompt(
    context: str,
    instruction: str,
    node_title: str,
    prior_message: str,
    reply_guide: str = "",
) -> str:
    facts = context.strip() or "You are a helpful voice assistant for this business."
    task = instruction.strip() or "Respond to the caller using the facts and their last message."
    prior = prior_message.strip()
    prior_block = f'\nPRIOR AI MESSAGE TO CALLER:\n"{prior}"\n' if prior else ""
    guide = reply_guide.strip()
    reply_block = (
        f"\nREPLY GUIDANCE (what to say aloud):\n{guide}\n"
        if guide
        else ""
    )
    reply_rules = (
        "- Follow REPLY GUIDANCE for tone and content; use the caller's words and FACTS.\n"
        "- Name specific items the caller mentioned when REPLY GUIDANCE calls for it.\n"
        if guide
        else ""
    )
    return f"""You are Susha, an AI voice agent on a live phone call. Follow the persona and facts below.

Speak immediately and clearly.
Use 2 to 3 short sentences. Maximum 60 words total. No thinking. No explanation.

LANGUAGE — highest priority: mirror the caller's language from their last message.
- English → Latin script only
- Hindi → Devanagari only
- Hinglish → Roman script mix, no Devanagari

FACTS — use ONLY this block. Do not invent amounts or dates:
{facts}

CURRENT WORKFLOW STEP: "{node_title}"
{prior_block}
YOUR TASK:
{task}
{reply_block}
RULES:
- You are Susha (the agent). NEVER address the caller as Susha.
- Caller name is the CONTACT DATA "name" field only.
- React to what the caller just said using ONLY the FACTS block and the task above.
{reply_rules}- If a fact exists (amount, fine, date, name), state it clearly.
- If a requested fact is NOT in FACTS, say "We'll get back to you on that." for that part only.
- Use CONTACT DATA fields when relevant.
- Do NOT repeat the prior question unless the task says to.
- Do NOT speak as the caller.
- Do NOT end the call or say goodbye."""


async def stream_context_react(
    transcript: str,
    context: str,
    instruction: str,
    node_title: str,
    prior_message: str,
    event_callback,
    cancel_event: asyncio.Event = None,
    stt_lang: str | None = None,
    on_language_retry=None,
    node_id: str | None = None,
    reply_guide: str = "",
) -> str:
    """Speak a reaction to the caller's last transcript using CONTEXT + instruction."""
    if cancel_event is None:
        cancel_event = asyncio.Event()

    prompt = build_context_react_prompt(
        context, instruction, node_title, prior_message, reply_guide
    )
    response_language = resolve_response_language(stt_lang, transcript or instruction)
    logger.info(
        f"[CONTEXT_REACT] node={node_id} transcript={transcript!r} lang={response_language}"
    )

    instruction_lang = LANG_INSTRUCTIONS[response_language]
    prior_line = f'Prior AI said: "{prior_message}"\n' if prior_message.strip() else ""
    user_content = (
        f"{instruction_lang}\n"
        f"{prior_line}"
        f'Caller said: "{transcript}"\n'
        f"Fulfill the task using FACTS only."
    )

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": user_content},
    ]

    await event_callback("llm_start", "")

    try:
        final_text = await _complete_once(messages, cancel_event, event_callback, stream_tokens=True)
    except asyncio.CancelledError:
        logger.info("[CONTEXT_REACT] CancelledError — interrupted")
        return ""
    except Exception as e:
        logger.error(f"[CONTEXT_REACT] {e}")
        await event_callback("llm_error", str(e))
        return ""

    if cancel_event.is_set():
        return ""

    if final_text and not output_matches_language(final_text, response_language):
        logger.warning(
            f"[CONTEXT_REACT] Language mismatch (wanted {response_language}): "
            f"{final_text[:80]!r} — retrying"
        )
        if on_language_retry:
            await on_language_retry()
        retry_content = (
            f"{RETRY_INSTRUCTIONS[response_language]}\n"
            f'Caller said: "{transcript}"\n'
            f"Fulfill the task using FACTS only."
        )
        retry_messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": retry_content},
        ]
        try:
            retry_text = await _complete_once(
                retry_messages, cancel_event, event_callback, stream_tokens=False
            )
            if retry_text and output_matches_language(retry_text, response_language):
                final_text = retry_text
        except Exception as e:
            logger.error(f"[CONTEXT_REACT] Retry failed: {e}")

    if not final_text:
        fallbacks = {"english": FALLBACK_EN, "hindi": FALLBACK_HI, "hinglish": FALLBACK_HINGLISH}
        final_text = fallbacks.get(response_language, FALLBACK_EN)

    logger.info(f"[CONTEXT_REACT] node={node_id} spoken={final_text!r}")
    await event_callback("llm_end", final_text, response_language)
    return final_text


async def stream_context_answer(
    transcript: str,
    context: str,
    node_title: str,
    node_message: str,
    event_callback,
    cancel_event: asyncio.Event = None,
    stt_lang: str | None = None,
    on_language_retry=None,
    node_id: str | None = None,
) -> str:
    """Answer off-script factual questions from CONTEXT only — no workflow script or history."""
    if cancel_event is None:
        cancel_event = asyncio.Event()

    prompt = build_node_fallback_prompt(context, node_title, node_message)
    response_language = resolve_response_language(stt_lang, transcript)
    logger.info(f"[CONTEXT_QA] node={node_id} question={transcript!r} lang={response_language}")

    instruction = LANG_INSTRUCTIONS[response_language]
    user_content = f"{instruction}\nCaller question: {transcript}\nAnswer using FACTS only."

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": user_content},
    ]

    await event_callback("llm_start", "")

    try:
        final_text = await _complete_once(messages, cancel_event, event_callback, stream_tokens=True)
    except asyncio.CancelledError:
        logger.info("[CONTEXT_QA] CancelledError — interrupted")
        return ""
    except Exception as e:
        logger.error(f"[CONTEXT_QA] {e}")
        await event_callback("llm_error", str(e))
        return ""

    if cancel_event.is_set():
        return ""

    if final_text and not output_matches_language(final_text, response_language):
        logger.warning(
            f"[CONTEXT_QA] Language mismatch (wanted {response_language}): {final_text[:80]!r} — retrying"
        )
        if on_language_retry:
            await on_language_retry()
        retry_content = f"{RETRY_INSTRUCTIONS[response_language]}\nCaller question: {transcript}\nAnswer using FACTS only."
        retry_messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": retry_content},
        ]
        try:
            retry_text = await _complete_once(retry_messages, cancel_event, event_callback, stream_tokens=False)
            if retry_text and output_matches_language(retry_text, response_language):
                final_text = retry_text
        except Exception as e:
            logger.error(f"[CONTEXT_QA] Retry failed: {e}")

    if not final_text:
        fallbacks = {"english": FALLBACK_EN, "hindi": FALLBACK_HI, "hinglish": FALLBACK_HINGLISH}
        final_text = fallbacks.get(response_language, FALLBACK_EN)

    logger.info(f"[CONTEXT_QA] node={node_id} answer={final_text!r}")
    await event_callback("llm_end", final_text, response_language)
    return final_text


async def close():
    await _http_client.aclose()
