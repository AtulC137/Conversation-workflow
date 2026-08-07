function parseBool(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value === "1" || value.toLowerCase() === "true";
}

export type TelephonyProvider = "piopiy" | "frejun" | "sip";

function parseTelephonyProvider(value: string | undefined): TelephonyProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "frejun") return "frejun";
  if (normalized === "sip") return "sip";
  return "piopiy";
}

export function getFeatureFlags() {
  return {
    useWsProxy: parseBool(process.env.USE_WS_PROXY),
    useVoiceHttpProxy: parseBool(process.env.USE_VOICE_HTTP_PROXY),
    useSessionRegisterApi: parseBool(process.env.USE_SESSION_REGISTER_API),
    telephonyProvider: parseTelephonyProvider(process.env.TELEPHONY_PROVIDER),
  };
}
