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
export type OrganizationRole = "admin" | "sub_admin" | "employee";

export type ApiOrganization = {
  id: string;
  name: string;
  slug: string;
};

export function hasPermission(
  role: OrganizationRole,
  permissions: PermissionsMap,
  key: PermissionKey,
): boolean {
  if (role === "admin") return true;
  return permissions[key] === true;
}
