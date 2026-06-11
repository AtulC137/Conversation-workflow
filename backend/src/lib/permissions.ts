import type { OrganizationRole } from "@prisma/client";

export const ALL_PERMISSIONS = [
  "dashboard.access",
  "users.view",
  "users.invite",
  "users.manage",
  "workflows.view_own",
  "workflows.view_all",
  "workflows.create",
  "workflows.edit_own",
  "workflows.edit_all",
  "workflows.delete",
  "workflows.publish",
  "workflows.test",
  "sessions.view_own",
  "sessions.view_all",
] as const;

export type PermissionKey = (typeof ALL_PERMISSIONS)[number];
export type PermissionsMap = Record<PermissionKey, boolean>;

export type MemberContext = {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  permissions: PermissionsMap;
};

function allTrue(): PermissionsMap {
  return Object.fromEntries(ALL_PERMISSIONS.map((k) => [k, true])) as PermissionsMap;
}

const SUB_ADMIN_DEFAULT: PermissionsMap = {
  "dashboard.access": false,
  "users.view": true,
  "users.invite": true,
  "users.manage": false,
  "workflows.view_own": true,
  "workflows.view_all": true,
  "workflows.create": true,
  "workflows.edit_own": true,
  "workflows.edit_all": false,
  "workflows.delete": false,
  "workflows.publish": true,
  "workflows.test": true,
  "sessions.view_own": true,
  "sessions.view_all": false,
};

const EMPLOYEE_DEFAULT: PermissionsMap = {
  "dashboard.access": false,
  "users.view": false,
  "users.invite": false,
  "users.manage": false,
  "workflows.view_own": true,
  "workflows.view_all": false,
  "workflows.create": true,
  "workflows.edit_own": true,
  "workflows.edit_all": false,
  "workflows.delete": false,
  "workflows.publish": false,
  "workflows.test": true,
  "sessions.view_own": true,
  "sessions.view_all": false,
};

export const ROLE_PRESETS: Record<OrganizationRole, PermissionsMap> = {
  admin: allTrue(),
  sub_admin: { ...SUB_ADMIN_DEFAULT },
  employee: { ...EMPLOYEE_DEFAULT },
};

export function permissionsForRole(role: OrganizationRole): PermissionsMap {
  return { ...ROLE_PRESETS[role] };
}

export function parsePermissions(raw: unknown, role: OrganizationRole): PermissionsMap {
  const base = permissionsForRole(role);
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  for (const key of ALL_PERMISSIONS) {
    if (typeof obj[key] === "boolean") {
      base[key] = obj[key];
    }
  }
  return base;
}

export function hasPermission(member: MemberContext, key: PermissionKey): boolean {
  if (member.role === "admin") return true;
  return member.permissions[key] === true;
}

export function canViewWorkflow(
  member: MemberContext,
  workflow: { userId: string; organizationId: string },
): boolean {
  if (workflow.organizationId !== member.organizationId) return false;
  if (workflow.userId === member.userId) {
    return hasPermission(member, "workflows.view_own");
  }
  return hasPermission(member, "workflows.view_all");
}

export function canEditWorkflow(
  member: MemberContext,
  workflow: { userId: string; organizationId: string },
): boolean {
  if (workflow.organizationId !== member.organizationId) return false;
  if (workflow.userId === member.userId) {
    return hasPermission(member, "workflows.edit_own");
  }
  return hasPermission(member, "workflows.edit_all");
}

export function canDeleteWorkflow(
  member: MemberContext,
  workflow: { userId: string; organizationId: string },
): boolean {
  if (!hasPermission(member, "workflows.delete")) return false;
  if (workflow.organizationId !== member.organizationId) return false;
  return workflow.userId === member.userId;
}
