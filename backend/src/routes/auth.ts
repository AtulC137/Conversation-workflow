import { Prisma } from "@prisma/client";
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
import { permissionsForRole } from "../lib/permissions.js";
import { prisma } from "../lib/prisma.js";
import { slugify } from "../lib/slug.js";
import { loadMembership, parsePermissions, requireAuth } from "../middleware/auth.js";
import type { AuthedRequest } from "../middleware/auth.js";

const REFRESH_COOKIE = "refresh_token";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120),
  organizationName: z.string().min(1).max(200),
  organizationSlug: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

const loginSchema = z.object({
  organizationSlug: z.string().min(1).max(80),
  email: z.string().email(),
  password: z.string().min(1),
});

const profileSchema = z.object({
  name: z.string().min(1).max(120),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
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

async function issueTokens(
  membership: {
    user: { id: string; email: string; name: string };
    organization: { id: string; slug: string; name: string };
    role: import("@prisma/client").OrganizationRole;
    permissions: unknown;
  },
  res: import("express").Response,
) {
  const permissions = parsePermissions(membership.permissions, membership.role);
  const accessToken = signAccessToken({
    sub: membership.user.id,
    email: membership.user.email,
    name: membership.user.name,
    organizationId: membership.organization.id,
    organizationSlug: membership.organization.slug,
    role: membership.role,
    permissions,
  });
  const refreshToken = generateRefreshToken();
  await prisma.authSession.create({
    data: {
      id: uuidv4(),
      userId: membership.user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshExpiresAt(),
    },
  });
  setRefreshCookie(res, refreshToken);
  return {
    accessToken,
    user: {
      id: membership.user.id,
      email: membership.user.email,
      name: membership.user.name,
    },
    organization: {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
    },
    role: membership.role,
    permissions,
  };
}

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { email, password, name, organizationName, organizationSlug } = parsed.data;

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const existingOrg = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
  });
  if (existingOrg) {
    res.status(409).json({ error: "Organization slug already taken" });
    return;
  }

  const orgId = uuidv4();
  const userId = uuidv4();
  const adminPerms = permissionsForRole("admin");

  const user = await prisma.user.create({
    data: {
      id: userId,
      email,
      name,
      passwordHash: await hashPassword(password),
      memberships: {
        create: {
          id: uuidv4(),
          organization: {
            create: {
              id: orgId,
              name: organizationName,
              slug: organizationSlug,
            },
          },
          role: "admin",
          permissions: adminPerms as unknown as Prisma.InputJsonValue,
          status: "active",
        },
      },
    },
    include: {
      memberships: { include: { organization: true } },
    },
  });

  const membership = user.memberships[0];
  if (!membership) {
    res.status(500).json({ error: "Failed to create organization membership" });
    return;
  }

  const tokens = await issueTokens(
    {
      user,
      organization: membership.organization,
      role: membership.role,
      permissions: membership.permissions,
    },
    res,
  );
  res.status(201).json(tokens);
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { organizationSlug, email, password } = parsed.data;

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
  });
  if (!organization) {
    res.status(401).json({ error: "Invalid organization, email, or password" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid organization, email, or password" });
    return;
  }

  const membership = await loadMembership(user.id, organization.id);
  if (!membership) {
    res.status(401).json({ error: "Invalid organization, email, or password" });
    return;
  }

  const tokens = await issueTokens(membership, res);
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

  const membership = await prisma.organizationMember.findFirst({
    where: { userId: session.user.id, status: "active" },
    include: { organization: true, user: true },
    orderBy: { createdAt: "asc" },
  });

  if (!membership) {
    res.status(401).json({ error: "No active organization membership" });
    return;
  }

  await prisma.authSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  const tokens = await issueTokens(membership, res);
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
  const membership = await loadMembership(req.user!.id, req.user!.organizationId);
  if (!membership) {
    res.status(401).json({ error: "Membership not found" });
    return;
  }

  const permissions = parsePermissions(membership.permissions, membership.role);

  res.json({
    user: {
      id: membership.user.id,
      email: membership.user.email,
      name: membership.user.name,
    },
    organization: {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
    },
    role: membership.role,
    permissions,
  });
});

authRouter.patch("/profile", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { name: parsed.data.name },
    select: { id: true, email: true, name: true },
  });

  res.json({ user });
});

authRouter.post("/change-password", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user || !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    res.status(400).json({ error: "Current password is incorrect" });
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(parsed.data.newPassword) },
  });

  res.json({ ok: true });
});

// Slug availability check for register UI
authRouter.get("/check-slug/:slug", async (req, res) => {
  const slug = slugify(req.params.slug ?? "");
  if (!slug) {
    res.status(400).json({ error: "Invalid slug" });
    return;
  }
  const existing = await prisma.organization.findUnique({ where: { slug } });
  res.json({ slug, available: !existing });
});
