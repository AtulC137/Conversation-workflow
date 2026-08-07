export const SESSION_EVENT_TYPES = [
  "ws_connected",
  "piopiy_connected",
  "frejun_connected",
  "sip_connected",
  "greeting_end",
  "speech_start",
  "interrupted",
  "client_interrupt",
  "silence_timeout",
  "branch_advance",
  "session_end",
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

export function isSessionEventType(value: string): value is SessionEventType {
  return (SESSION_EVENT_TYPES as readonly string[]).includes(value);
}
