import { Fragment, useState } from "react";
import type { OrganizationRole, PermissionsMap } from "@/lib/permissions";
import type { OrgMember } from "@/lib/api/org";
import { updateMember } from "@/lib/api/org";
import { PermissionCheckboxes } from "./PermissionCheckboxes";

type Props = {
  members: OrgMember[];
  currentUserId: string;
  canManage: boolean;
  rolePresets: Record<OrganizationRole, PermissionsMap>;
  onUpdated: () => void;
};

export function MembersTable({
  members,
  currentUserId,
  canManage,
  rolePresets,
  onUpdated,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draftPerms, setDraftPerms] = useState<PermissionsMap | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleRoleChange(member: OrgMember, role: OrganizationRole) {
    setError("");
    setSaving(true);
    try {
      await updateMember(member.id, { role, permissions: rolePresets[role] });
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePermissions(member: OrgMember) {
    if (!draftPerms) return;
    setError("");
    setSaving(true);
    try {
      await updateMember(member.id, { permissions: draftPerms });
      setExpandedId(null);
      setDraftPerms(null);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <Fragment key={m.id}>
                <tr className="border-t border-border">
                  <td className="px-4 py-3 font-medium">
                    {m.name}
                    {m.userId === currentUserId && (
                      <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{m.email}</td>
                  <td className="px-4 py-3">
                    {canManage ? (
                      <select
                        value={m.role}
                        disabled={saving}
                        onChange={(e) => handleRoleChange(m, e.target.value as OrganizationRole)}
                        className="rounded-md border border-border px-2 py-1 text-xs"
                      >
                        <option value="employee">Employee</option>
                        <option value="sub_admin">Sub-admin</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : (
                      <span className="capitalize">{m.role.replace("_", " ")}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 capitalize">{m.status}</td>
                  <td className="px-4 py-3">
                    {canManage && (m.role === "sub_admin" || m.role === "employee") && (
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedId(expandedId === m.id ? null : m.id);
                          setDraftPerms(m.permissions);
                        }}
                        className="text-xs font-medium text-foreground underline"
                      >
                        {expandedId === m.id ? "Hide permissions" : "Edit permissions"}
                      </button>
                    )}
                  </td>
                </tr>
                {expandedId === m.id && draftPerms && (
                  <tr className="border-t border-border bg-muted/20">
                    <td colSpan={5} className="px-4 py-4">
                      <PermissionCheckboxes
                        role={m.role}
                        permissions={draftPerms}
                        onChange={setDraftPerms}
                      />
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => handleSavePermissions(m)}
                        className="mt-3 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-60"
                      >
                        Save permissions
                      </button>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
