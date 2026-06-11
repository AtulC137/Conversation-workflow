import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { startCleanupScheduler } from "./lib/cleanup.js";
import { authRouter } from "./routes/auth.js";
import { orgRouter } from "./routes/org.js";
import { voiceSessionsRouter } from "./routes/voice-sessions.js";
import { workflowsRouter } from "./routes/workflows.js";

const app = express();
const port = Number(process.env.PORT ?? "3001");
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:8080";

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
app.use("/api/workflows", workflowsRouter);
app.use("/api/voice-sessions", voiceSessionsRouter);

startCleanupScheduler();

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
