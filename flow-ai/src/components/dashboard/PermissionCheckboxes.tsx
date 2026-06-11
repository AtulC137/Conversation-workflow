import type { OrganizationRole, PermissionKey, PermissionsMap } from "@/lib/permissions";
import { ALL_PERMISSIONS } from "@/lib/permissions";

const LABELS: Record<PermissionKey, string> = {
  "dashboard.access": "Dashboard access",
  "users.view": "View users",
  "users.invite": "Invite users",
  "users.manage": "Manage permissions",
  "workflows.view_own": "View own workflows",
  "workflows.view_all": "View all workflows",
  "workflows.create": "Create workflows",
  "workflows.edit_own": "Edit own workflows",
  "workflows.edit_all": "Edit all workflows",
  "workflows.delete": "Delete workflows",
  "workflows.publish": "Publish workflows",
  "workflows.test": "Test workflows",
  "sessions.view_own": "View own transcripts",
  "sessions.view_all": "View all transcripts",
};

type Props = {
  role: OrganizationRole;
  permissions: PermissionsMap;
  disabled?: boolean;
  onChange?: (permissions: PermissionsMap) => void;
};

export function PermissionCheckboxes({ role, permissions, disabled, onChange }: Props) {
  const readOnly = disabled || role === "admin" || !onChange;

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {ALL_PERMISSIONS.map((key) => (
        <label
          key={key}
          className={`flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs ${
            readOnly ? "opacity-70" : "cursor-pointer hover:bg-muted/40"
          }`}
        >
          <input
            type="checkbox"
            checked={role === "admin" ? true : permissions[key]}
            disabled={readOnly}
            onChange={(e) => {
              if (!onChange) return;
              onChange({ ...permissions, [key]: e.target.checked });
            }}
            className="h-3.5 w-3.5"
          />
          <span>{LABELS[key]}</span>
        </label>
      ))}
    </div>
  );
}
