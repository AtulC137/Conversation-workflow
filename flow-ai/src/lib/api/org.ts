import type { OrganizationRole, PermissionKey, PermissionsMap } from "@/lib/permissions";
import { apiFetch } from "./client";

export type OrgMember = {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: OrganizationRole;
  permissions: PermissionsMap;
  status: string;
  createdAt: number;
};

export async function fetchOrg() {
  return apiFetch<{
    organization: { id: string; name: string; slug: string; memberCount: number };
  }>("/api/org");
}

export async function fetchOrgMembers() {
  return apiFetch<{ members: OrgMember[] }>("/api/org/members");
}

export async function fetchPermissionsSchema() {
  return apiFetch<{
    permissions: PermissionKey[];
    rolePresets: Record<OrganizationRole, PermissionsMap>;
  }>("/api/org/permissions/schema");
}

export async function inviteMember(payload: {
  name: string;
  email: string;
  password: string;
  role: OrganizationRole;
}) {
  return apiFetch<{ member: OrgMember }>("/api/org/members", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateMember(
  memberId: string,
  payload: {
    role?: OrganizationRole;
    permissions?: Partial<PermissionsMap>;
    status?: "active" | "invited" | "disabled";
  },
) {
  return apiFetch<{ member: OrgMember }>(`/api/org/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
