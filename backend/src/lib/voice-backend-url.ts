import { getFeatureFlags } from "./feature-flags.js";

const VOICE_BACKEND_URL = process.env.VOICE_BACKEND_URL ?? "http://localhost:8000";
const PORT = process.env.PORT ?? "3001";

/** Direct Python voice service URL — always used as HTTP/WS proxy upstream target. */
export function getVoiceServiceTargetUrl(): string {
  return VOICE_BACKEND_URL.replace(/\/$/, "");
}

/**
 * Resolve the URL Node uses when calling the Python voice service (server-to-server).
 * When USE_VOICE_HTTP_PROXY is on, calls loop through the local gateway for integration testing.
 */
export function getVoiceBackendSessionsUrl(): string {
  const { useVoiceHttpProxy, useSessionRegisterApi } = getFeatureFlags();
  const directBase = getVoiceServiceTargetUrl();
  const gatewayBase = `http://localhost:${PORT}/voice`;

  if (useSessionRegisterApi) {
    if (useVoiceHttpProxy) {
      return `${gatewayBase}/internal/session/register`;
    }
    return `${directBase}/internal/session/register`;
  }

  if (useVoiceHttpProxy) {
    return `${gatewayBase}/sessions`;
  }
  return `${directBase}/sessions`;
}

function outboundPathForProvider(provider: string): string {
  if (provider === "frejun") return "/frejun/outbound-call";
  if (provider === "sip") return "/sip/outbound-call";
  return "/piopiy/outbound-call";
}

export function getVoiceBackendOutboundUrl(): string {
  const { useVoiceHttpProxy, telephonyProvider } = getFeatureFlags();
  const path = outboundPathForProvider(telephonyProvider);
  if (useVoiceHttpProxy) {
    return `http://localhost:${PORT}/voice${path}`;
  }
  return `${getVoiceServiceTargetUrl()}${path}`;
}
