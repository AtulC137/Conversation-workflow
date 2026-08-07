import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { Express, Request, Response } from "express";
import httpProxy from "http-proxy";
import { getFeatureFlags } from "../lib/feature-flags.js";
import { prisma } from "../lib/prisma.js";
import { getVoiceServiceTargetUrl } from "../lib/voice-backend-url.js";

const VOICE_PATH_MAP: Record<string, string> = {
  "/voice/health": "/health",
  "/voice/sessions": "/sessions",
  "/voice/internal/session/register": "/internal/session/register",
  "/voice/piopiy/outbound-call": "/piopiy/outbound-call",
  "/voice/frejun/outbound-call": "/frejun/outbound-call",
  "/voice/frejun/flow": "/frejun/flow",
  "/voice/frejun/webhook": "/frejun/webhook",
  "/voice/sip/outbound-call": "/sip/outbound-call",
  "/voice/internal/sip/inbound-resolve": "/internal/sip/inbound-resolve",
};

function rewriteVoicePath(path: string): string {
  if (path.startsWith("/voice/sessions/")) {
    return path.replace("/voice/sessions/", "/sessions/");
  }
  return VOICE_PATH_MAP[path] ?? path;
}

export function createVoiceProxy() {
  return httpProxy.createProxyServer({
    target: getVoiceServiceTargetUrl(),
    ws: true,
    changeOrigin: true,
  });
}

async function validateWsSession(sessionId: string | null): Promise<boolean> {
  if (!sessionId) return false;

  const session = await prisma.voiceSession.findFirst({
    where: {
      id: sessionId,
      status: "active",
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });

  return session !== null;
}

export function mountVoiceGateway(app: Express, proxy: httpProxy): void {
  app.use((req: Request, res: Response, next) => {
    if (!req.path.startsWith("/voice/")) {
      next();
      return;
    }

    const upstreamPath = rewriteVoicePath(req.path);
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    req.url = upstreamPath + query;

    proxy.web(req, res, { target: getVoiceServiceTargetUrl() }, (err) => {
      console.error("[voice-gateway] HTTP proxy error:", err);
      if (!res.headersSent) {
        res.status(502).json({ error: "Voice service unavailable" });
      }
    });
  });
}

export async function handleVoiceWsUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  proxy: httpProxy,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/voice/frejun/media-stream") {
    req.url = `/frejun/media-stream${url.search}`;
    proxy.ws(req, socket, head, { target: getVoiceServiceTargetUrl() }, (err) => {
      console.error("[voice-gateway] FreJun WS proxy error:", err);
      socket.destroy();
    });
    return;
  }

  if (url.pathname !== "/voice/ws/audio") {
    socket.destroy();
    return;
  }

  if (!getFeatureFlags().useWsProxy) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }

  const sessionId = url.searchParams.get("sessionId");
  const valid = await validateWsSession(sessionId);
  if (!valid) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  req.url = `/ws/audio${url.search}`;
  proxy.ws(req, socket, head, { target: getVoiceServiceTargetUrl() }, (err) => {
    console.error("[voice-gateway] WS proxy error:", err);
    socket.destroy();
  });
}
