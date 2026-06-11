import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { OrganizationRole } from "@prisma/client";
import type { PermissionsMap } from "./permissions.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-jwt-secret-change-in-production";
const JWT_ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES ?? "15m";
const REFRESH_DAYS = Number(process.env.JWT_REFRESH_EXPIRES_DAYS ?? "30");

export type AccessTokenPayload = {
  sub: string;
  email: string;
  name: string;
  organizationId: string;
  organizationSlug: string;
  role: OrganizationRole;
  permissions: PermissionsMap;
};

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: SignOptions = { expiresIn: JWT_ACCESS_EXPIRES as SignOptions["expiresIn"] };
  return jwt.sign(payload, JWT_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AccessTokenPayload;
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function refreshExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_DAYS);
  return d;
}
