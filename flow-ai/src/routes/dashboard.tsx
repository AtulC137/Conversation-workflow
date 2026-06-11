import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, UserPlus } from "lucide-react";
import { hasPermission, type PermissionsMap, type OrganizationRole } from "@/lib/permissions";
import { useAuth } from "@/lib/auth/AuthContext";
import {
  fetchOrg,
  fetchOrgMembers,
  fetchPermissionsSchema,
  type OrgMember,
} from "@/lib/api/org";
import { MembersTable } from "@/components/dashboard/MembersTable";
import { InviteMemberDialog } from "@/components/dashboard/InviteMemberDialog";

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  const { user, organization, role, permissions, loading } = useAuth();
  const [orgName, setOrgName] = useState("");
  const [memberCount, setMemberCount] = useState(0);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [rolePresets, setRolePresets] = useState<Record<OrganizationRole, PermissionsMap> | null>(
    null,
  );
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [orgRes, membersRes, schemaRes] = await Promise.all([
        fetchOrg(),
        fetchOrgMembers(),
        fetchPermissionsSchema(),
      ]);
      setOrgName(orgRes.organization.name);
      setMemberCount(orgRes.organization.memberCount);
      setMembers(membersRes.members);
      setRolePresets(schemaRes.rolePresets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setPageLoading(false);
    }
  }, []);

  const canAccessDashboard =
    !!role && !!permissions && hasPermission(role, permissions, "dashboard.access");

  useEffect(() => {
    if (!loading && canAccessDashboard) {
      load();
    } else if (!loading) {
      setPageLoading(false);
    }
  }, [loading, canAccessDashboard, load]);

  if (loading || pageLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading dashboard…
      </div>
    );
  }

  if (!canAccessDashboard) {
    return <Navigate to="/" />;
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b border-border bg-white px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted/40"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Workflows
            </Link>
            <div>
              <h1 className="text-lg font-semibold">Organization dashboard</h1>
              <p className="text-sm text-muted-foreground">
                {orgName || organization?.name} · {memberCount} members
              </p>
            </div>
          </div>
          {role && permissions && hasPermission(role, permissions, "users.invite") && (
            <button
              type="button"
              onClick={() => setInviteOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-xs font-medium text-background"
            >
              <UserPlus className="h-3.5 w-3.5" /> Invite member
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6">
        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
        {rolePresets && user && (
          <MembersTable
            members={members}
            currentUserId={user.id}
            canManage={
              !!role && !!permissions && hasPermission(role, permissions, "users.manage")
            }
            rolePresets={rolePresets}
            onUpdated={load}
          />
        )}
      </main>

      <InviteMemberDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={load}
      />
    </div>
  );
}
