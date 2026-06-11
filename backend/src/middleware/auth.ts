import type { NextFunction, Request, Response } from "express";
import type { OrganizationRole } from "@prisma/client";
import { verifyAccessToken } from "../lib/auth.js";
import {
  hasPermission,
  parsePermissions,
  type PermissionKey,
  type PermissionsMap,
} from "../lib/permissions.js";
import { prisma } from "../lib/prisma.js";

export type AuthedUser = {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  role: OrganizationRole;
  permissions: PermissionsMap;
};

export type AuthedRequest = Request & {
  user?: AuthedUser;
};

export async function loadMembership(userId: string, organizationId: string) {
  return prisma.organizationMember.findFirst({
    where: { userId, organizationId, status: "active" },
    include: { organization: true, user: true },
  });
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const payload = verifyAccessToken(header.slice(7));
    const membership = await loadMembership(payload.sub, payload.organizationId);

    if (!membership) {
      res.status(401).json({ error: "Membership not found or inactive" });
      return;
    }

    const permissions = parsePermissions(membership.permissions, membership.role);

    req.user = {
      id: membership.user.id,
      email: membership.user.email,
      name: membership.user.name,
      organizationId: membership.organization.id,
      organizationSlug: membership.organization.slug,
      organizationName: membership.organization.name,
      role: membership.role,
      permissions,
    };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requirePermission(...keys: PermissionKey[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const member = {
      userId: req.user.id,
      organizationId: req.user.organizationId,
      role: req.user.role,
      permissions: req.user.permissions,
    };

    const allowed = keys.some((key) => hasPermission(member, key));
    if (!allowed) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}

export { parsePermissions };
