/** Build the browser mic test page URL for a voice session. */
export function buildVoiceMicUiUrl(sessionId: string): string {
  const params = new URLSearchParams({ session: sessionId });
  const wsMode = import.meta.env.VITE_VOICE_WS_MODE ?? "direct";

  if (wsMode === "proxy") {
    const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
    let apiPort = "3001";
    try {
      apiPort = new URL(apiUrl).port || (apiUrl.startsWith("https") ? "443" : "80");
    } catch {
      // keep default
    }
    params.set("wsProxy", "1");
    params.set("apiPort", apiPort);
  }

  return `/voice-mic-ui.html?${params.toString()}`;
}
