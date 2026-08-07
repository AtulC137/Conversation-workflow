"""Shared phone number helpers for telephony providers."""

from __future__ import annotations

import re

_E164_RE = re.compile(r"^\+?[1-9]\d{6,14}$")


def normalize_phone_number(phone: str) -> str:
    """Normalize to E.164 with leading +."""
    cleaned = phone.strip().replace(" ", "").replace("-", "")
    if not _E164_RE.match(cleaned):
        raise ValueError("Phone number must be E.164 format, e.g. +919876543210")
    return cleaned if cleaned.startswith("+") else f"+{cleaned.lstrip('+')}"
