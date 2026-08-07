"""SIP trunk outbound call trigger via Asterisk AMI."""

from __future__ import annotations

import asyncio
import logging
import os
import re

from pydantic import BaseModel

from phone_utils import normalize_phone_number

logger = logging.getLogger("sip_outbound")

_E164_RE = re.compile(r"^\+?[1-9]\d{6,14}$")


class OutboundCallBody(BaseModel):
    sessionId: str
    phoneNumber: str


def _session_uuid_hex(session_id: str) -> str:
    """Convert session UUID to 32-char hex for Asterisk AudioSocket."""
    return session_id.replace("-", "").lower()


class AmiClient:
    """Minimal async AMI client for Originate actions."""

    def __init__(self, host: str, port: int, username: str, secret: str) -> None:
        self._host = host
        self._port = port
        self._username = username
        self._secret = secret

    async def originate_outbound(self, session_id: str, phone_number: str) -> dict:
        reader, writer = await asyncio.open_connection(self._host, self._port)
        try:
            await self._login(writer, reader)
            caller_id = os.environ.get("SIP_TRUNK_CALLER_ID", "").strip()
            session_uuid = _session_uuid_hex(session_id)
            to_e164 = normalize_phone_number(phone_number)

            action = (
                "Action: Originate\r\n"
                f"Channel: PJSIP/{to_e164}@frejun-trunk\r\n"
                "Context: outbound-ai\r\n"
                "Exten: connect\r\n"
                "Priority: 1\r\n"
                f"CallerID: <{caller_id}>\r\n"
                f"Variable: SESSION_ID={session_id}\r\n"
                f"Variable: SESSION_UUID={session_uuid}\r\n"
                "Async: true\r\n"
                "\r\n"
            )
            writer.write(action.encode())
            await writer.drain()

            response = await self._wait_for_action_response(reader)
            if not self._response_success(response):
                logger.error(f"[SIP OUTBOUND] AMI originate failed: {response}")
                raise RuntimeError(f"AMI originate failed: {response[:200]}")

            logger.info(f"[SIP OUTBOUND] AMI originate accepted for {to_e164} session={session_id}")
            return {
                "status": "calling",
                "sessionId": session_id,
                "phoneNumber": to_e164,
            }
        finally:
            try:
                writer.write(b"Action: Logoff\r\n\r\n")
                await writer.drain()
            except Exception:
                pass
            writer.close()
            await writer.wait_closed()

    async def _login(self, writer: asyncio.StreamWriter, reader: asyncio.StreamReader) -> None:
        login = (
            "Action: Login\r\n"
            f"Username: {self._username}\r\n"
            f"Secret: {self._secret}\r\n"
            "Events: off\r\n"
            "\r\n"
        )
        writer.write(login.encode())
        await writer.drain()
        response = await self._wait_for_action_response(reader)
        if not self._response_success(response):
            raise RuntimeError(f"AMI login failed: {response[:200]}")

    @staticmethod
    def _response_success(message: str) -> bool:
        return "Response: Success" in message

    async def _read_message(self, reader: asyncio.StreamReader, timeout: float = 10.0) -> str:
        chunks: list[str] = []
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=timeout)
            if not line:
                break
            decoded = line.decode(errors="replace")
            chunks.append(decoded)
            if decoded.strip() == "":
                break
        return "".join(chunks)

    async def _wait_for_action_response(self, reader: asyncio.StreamReader) -> str:
        """Read AMI blocks until a Response (not Event) is received."""
        while True:
            message = await self._read_message(reader)
            if not message:
                raise RuntimeError("AMI connection closed before action response")
            if "Response:" in message:
                return message
            first_line = message.splitlines()[0] if message else ""
            logger.debug(f"[SIP OUTBOUND] AMI event skipped: {first_line}")


async def trigger_outbound_call(session_id: str, phone_number: str) -> dict:
    host = os.environ.get("ASTERISK_AMI_HOST", "asterisk").strip()
    port = int(os.environ.get("ASTERISK_AMI_PORT", "5038"))
    user = os.environ.get("ASTERISK_AMI_USER", "voiceagent").strip()
    secret = os.environ.get("ASTERISK_AMI_SECRET", "").strip()
    caller_id = os.environ.get("SIP_TRUNK_CALLER_ID", "").strip()

    if not user or not secret:
        raise ValueError("ASTERISK_AMI_USER and ASTERISK_AMI_SECRET must be set")
    if not caller_id:
        raise ValueError("SIP_TRUNK_CALLER_ID must be set")

    if not _E164_RE.match(phone_number.strip().replace(" ", "").replace("-", "")):
        raise ValueError("Phone number must be E.164 format, e.g. +919876543210")

    client = AmiClient(host, port, user, secret)
    return await client.originate_outbound(session_id, phone_number)
