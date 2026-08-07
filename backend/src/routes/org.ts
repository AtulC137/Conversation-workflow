import { Prisma } from "@prisma/client";
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { hashPassword } from "../lib/auth.js";
import {
  ALL_PERMISSIONS,
  permissionsForRole,
  ROLE_PRESETS,
  parsePermissions,
  validatePermissionsMap,
} from "../lib/permissions.js";
import { prisma } from "../lib/prisma.js";
import { routeParam } from "../lib/params.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const inviteSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["admin", "sub_admin", "employee"]).default("employee"),
});

const patchMemberSchema = z.object({
  role: z.enum(["admin", "sub_admin", "employee"]).optional(),
  permissions: z.record(z.boolean()).optional(),
  status: z.enum(["active", "invited", "disabled"]).optional(),
});

export const orgRouter = Router();
orgRouter.use(requireAuth);

orgRouter.get("/", async (req: AuthedRequest, res) => {
  const orgId = req.user!.organizationId;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    include: { _count: { select: { members: true } } },
  });
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }
  res.json({
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      memberCount: org._count.members,
    },
  });
});

orgRouter.get("/permissions/schema", requirePermission("users.view"), (_req, res) => {
  res.json({
    permissions: ALL_PERMISSIONS,
    rolePresets: ROLE_PRESETS,
  });
});

orgRouter.get("/members", requirePermission("users.view"), async (req: AuthedRequest, res) => {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId: req.user!.organizationId },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });

  res.json({
    members: members.map((m) => ({
      id: m.id,
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      permissions: parsePermissions(m.permissions, m.role),
      status: m.status,
      createdAt: m.createdAt.getTime(),
    })),
  });
});

orgRouter.post("/members", requirePermission("users.invite"), async (req: AuthedRequest, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { name, email, password, role } = parsed.data;
  const orgId = req.user!.organizationId;

  const existingMember = await prisma.organizationMember.findFirst({
    where: {
      organizationId: orgId,
      user: { email },
    },
  });
  if (existingMember) {
    res.status(409).json({ error: "User is already a member of this organization" });
    return;
  }

  let user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    const otherOrg = await prisma.organizationMember.findFirst({
      where: { userId: user.id, organizationId: { not: orgId } },
    });
    if (otherOrg) {
      res.status(409).json({
        error: "This email belongs to a user in another organization",
      });
      return;
    }
  }

  const perms = permissionsForRole(role);
  const validatedPerms = validatePermissionsMap(perms);
  if (!validatedPerms) {
    res.status(500).json({ error: "Invalid role permissions preset" });
    return;
  }

  if (!user) {
    user = await prisma.user.create({
      data: {
        id: uuidv4(),
        email,
        name,
        passwordHash: await hashPassword(password),
      },
    });
  }

  const member = await prisma.organizationMember.create({
    data: {
      id: uuidv4(),
      organizationId: orgId,
      userId: user.id,
      role,
      permissions: validatedPerms as unknown as Prisma.InputJsonValue,
      status: "active",
    },
    include: { user: { select: { id: true, email: true, name: true } } },
  });

  res.status(201).json({
    member: {
      id: member.id,
      userId: member.user.id,
      email: member.user.email,
      name: member.user.name,
      role: member.role,
      permissions: parsePermissions(member.permissions, member.role),
      status: member.status,
      createdAt: member.createdAt.getTime(),
    },
  });
});

orgRouter.patch("/members/:id", requirePermission("users.manage"), async (req: AuthedRequest, res) => {
  const parsed = patchMemberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const memberId = routeParam(req.params.id);
  const orgId = req.user!.organizationId;

  const member = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId: orgId },
    include: { user: true },
  });
  if (!member) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const data = parsed.data;
  const newRole = data.role ?? member.role;

  if (data.role === "employee" || data.role === "sub_admin") {
    if (member.userId === req.user!.id && member.role === "admin") {
      const adminCount = await prisma.organizationMember.count({
        where: { organizationId: orgId, role: "admin", status: "active" },
      });
      if (adminCount <= 1) {
        res.status(400).json({ error: "Cannot demote the last admin" });
        return;
      }
    }
  }

  if (data.status === "disabled" && member.role === "admin") {
    const adminCount = await prisma.organizationMember.count({
      where: { organizationId: orgId, role: "admin", status: "active", id: { not: memberId } },
    });
    if (adminCount < 1) {
      res.status(400).json({ error: "Cannot disable the last admin" });
      return;
    }
  }

  let permissions = parsePermissions(member.permissions, member.role);
  if (data.role !== undefined) {
    permissions = permissionsForRole(data.role);
  }
  if (data.permissions) {
    for (const [key, val] of Object.entries(data.permissions)) {
      if (ALL_PERMISSIONS.includes(key as (typeof ALL_PERMISSIONS)[number]) && typeof val === "boolean") {
        permissions[key as (typeof ALL_PERMISSIONS)[number]] = val;
      }
    }
  }

  if (newRole === "admin") {
    permissions = permissionsForRole("admin");
  }

  const validatedPermissions = validatePermissionsMap(permissions);
  if (!validatedPermissions) {
    res.status(400).json({ error: "Invalid permissions" });
    return;
  }

  const updated = await prisma.organizationMember.update({
    where: { id: member.id },
    data: {
      ...(data.role !== undefined && { role: data.role }),
      ...(data.status !== undefined && { status: data.status }),
      permissions: validatedPermissions as unknown as Prisma.InputJsonValue,
    },
    include: { user: { select: { id: true, email: true, name: true } } },
  });

  res.json({
    member: {
      id: updated.id,
      userId: updated.user.id,
      email: updated.user.email,
      name: updated.user.name,
      role: updated.role,
      permissions: parsePermissions(updated.permissions, updated.role),
      status: updated.status,
      createdAt: updated.createdAt.getTime(),
    },
  });
});
