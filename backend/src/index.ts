import http from "node:http";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { startCleanupScheduler } from "./lib/cleanup.js";
import { authRouter } from "./routes/auth.js";
import { orgRouter } from "./routes/org.js";
import {
  createVoiceProxy,
  handleVoiceWsUpgrade,
  mountVoiceGateway,
} from "./routes/voice-gateway.js";
import { voiceSessionsRouter } from "./routes/voice-sessions.js";
import { templatesRouter } from "./routes/templates.js";
import { workflowsRouter } from "./routes/workflows.js";
import { campaignsRouter } from "./routes/campaigns.js";

const app = express();
const port = Number(process.env.PORT ?? "3001");
const corsOrigin = (process.env.CORS_ORIGIN ?? "http://localhost:8080")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api/org", orgRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/workflows", workflowsRouter);
app.use("/api/voice-sessions", voiceSessionsRouter);
app.use("/api/campaigns", campaignsRouter);

const voiceProxy = createVoiceProxy();
mountVoiceGateway(app, voiceProxy);

startCleanupScheduler();

const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  void handleVoiceWsUpgrade(req, socket, head, voiceProxy);
});

server.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
