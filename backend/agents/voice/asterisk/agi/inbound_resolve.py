#!/usr/bin/env python3
"""AGI script: resolve inbound DID to voice session via voice-backend HTTP API."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


def agi_read_env() -> dict[str, str]:
    env: dict[str, str] = {}
    while True:
        line = sys.stdin.readline().strip()
        if not line:
            break
        if ": " in line:
            key, value = line.split(": ", 1)
            env[key] = value
    return env


def agi_command(cmd: str) -> str:
    sys.stdout.write(cmd + "\n")
    sys.stdout.flush()
    return sys.stdin.readline().strip()


def get_channel_var(name: str) -> str:
    result = agi_command(f"GET VARIABLE {name}")
    if "result=1" in result and "(" in result:
        return result.split("(", 1)[1].rstrip(")")
    return ""


def main() -> None:
    agi_read_env()
    called = get_channel_var("CALLED_DID") or get_channel_var("EXTEN")
    backend_url = os.environ.get(
        "VOICE_BACKEND_URL", "http://voice-backend:8000"
    ).rstrip("/")
    resolve_url = f"{backend_url}/internal/sip/inbound-resolve"

    session_id = ""
    session_uuid = ""

    try:
        payload = json.dumps({"toNumber": called}).encode()
        req = urllib.request.Request(
            resolve_url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            session_id = data.get("sessionId", "")
            session_uuid = data.get("sessionUuid", "")
    except urllib.error.HTTPError as e:
        agi_command(f'VERBOSE "inbound_resolve HTTP {e.code}" 1')
    except Exception as e:
        agi_command(f'VERBOSE "inbound_resolve error: {e}" 1')

    agi_command(f'SET VARIABLE SESSION_ID "{session_id}"')
    agi_command(f'SET VARIABLE SESSION_UUID "{session_uuid}"')
    if session_id:
        agi_command('VERBOSE "inbound session resolved" 1')
    else:
        agi_command('VERBOSE "inbound resolve failed" 1')


if __name__ == "__main__":
    main()
