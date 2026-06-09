import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/auth.js";

export type AuthedRequest = Request & {
  user?: { id: string; email: string; name: string };
};

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const payload = verifyAccessToken(header.slice(7));
    req.user = { id: payload.sub, email: payload.email, name: payload.name };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
