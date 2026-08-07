"""Parse per-call contact fields from session context and apply {{placeholders}}."""

from __future__ import annotations

import copy
import re
from typing import Any

_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z0-9_\s]+)\s*\}\}")
_CONTACT_LINE = re.compile(r"^-\s*([^:]+):\s*(.+)$")
_NAME_KEYS = frozenset({"name", "fullname", "contactname", "customername", "guest", "caller"})


def _norm(key: str) -> str:
    return re.sub(r"[\s_-]+", "", key.strip().lower())


def parse_contact_fields(context: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    in_block = False
    for raw in (context or "").splitlines():
        line = raw.strip()
        if line.startswith("CONTACT DATA"):
            in_block = True
            continue
        if line.startswith("IDENTITY"):
            continue
        if line.startswith("- AGENT_NAME:") or line.startswith("- CALLER_NAME:"):
            if "CALLER_NAME:" in line:
                name = line.split("CALLER_NAME:", 1)[-1].strip()
                if name and name.upper() != "UNKNOWN":
                    fields.setdefault("name", name)
            continue
        if not in_block:
            # Also accept CALLER_NAME before CONTACT DATA block
            continue
        if not line:
            if fields:
                break
            continue
        m = _CONTACT_LINE.match(line)
        if m:
            fields[m.group(1).strip()] = m.group(2).strip()
    return fields


def resolve_field(fields: dict[str, str], raw_key: str) -> str | None:
    nk = _norm(raw_key)
    for k, v in fields.items():
        if _norm(k) == nk and v.strip():
            return v.strip()
    if nk == "name":
        for k, v in fields.items():
            if _norm(k) in _NAME_KEYS and v.strip():
                return v.strip()
    return None


def apply_contact_placeholders(text: str, fields: dict[str, str]) -> str:
    if not text or not fields:
        return text

    def repl(match: re.Match[str]) -> str:
        val = resolve_field(fields, match.group(1))
        return val if val is not None else match.group(0)

    return _PLACEHOLDER.sub(repl, text)


def strip_unresolved_placeholders(text: str) -> str:
    if not text:
        return text
    cleaned = _PLACEHOLDER.sub("", text)
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def sanitize_tts_text(text: str, fields: dict[str, str] | None = None) -> str:
    out = apply_contact_placeholders(text, fields or {})
    out = strip_unresolved_placeholders(out)
    return out.strip()


def patch_graph_placeholders(graph: dict[str, Any], fields: dict[str, str]) -> dict[str, Any]:
    if not fields or not graph:
        return graph
    patched = copy.deepcopy(graph)
    for node in patched.get("nodes", []):
        if not isinstance(node, dict):
            continue
        for key in ("message", "instruction", "replyGuide", "title"):
            val = node.get(key)
            if isinstance(val, str) and val.strip():
                node[key] = apply_contact_placeholders(val, fields)
    return patched
