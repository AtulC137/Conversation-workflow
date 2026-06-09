import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  refreshExpiresAt,
  signAccessToken,
  verifyPassword,
} from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

const REFRESH_COOKIE = "refresh_token";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRouter = Router();

function setRefreshCookie(res: import("express").Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: Number(process.env.JWT_REFRESH_EXPIRES_DAYS ?? "30") * 24 * 60 * 60 * 1000,
    path: "/api/auth",
  });
}

async function issueTokens(user: { id: string; email: string; name: string }, res: import("express").Response) {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, name: user.name });
  const refreshToken = generateRefreshToken();
  await prisma.authSession.create({
    data: {
      id: uuidv4(),
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshExpiresAt(),
    },
  });
  setRefreshCookie(res, refreshToken);
  return { accessToken, user: { id: user.id, email: user.email, name: user.name } };
}

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { email, password, name } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const user = await prisma.user.create({
    data: {
      id: uuidv4(),
      email,
      name,
      passwordHash: await hashPassword(password),
    },
  });

  const tokens = await issueTokens(user, res);
  res.status(201).json(tokens);
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const tokens = await issueTokens(user, res);
  res.json(tokens);
});

authRouter.post("/refresh", async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!raw) {
    res.status(401).json({ error: "No refresh token" });
    return;
  }

  const hash = hashRefreshToken(raw);
  const session = await prisma.authSession.findFirst({
    where: {
      refreshTokenHash: hash,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: true },
  });

  if (!session) {
    res.status(401).json({ error: "Invalid refresh token" });
    return;
  }

  await prisma.authSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  const tokens = await issueTokens(session.user, res);
  res.json(tokens);
});

authRouter.post("/logout", requireAuth, async (req: AuthedRequest, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (raw) {
    const hash = hashRefreshToken(raw);
    await prisma.authSession.updateMany({
      where: { refreshTokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});
