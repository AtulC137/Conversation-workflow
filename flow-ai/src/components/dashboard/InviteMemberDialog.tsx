import { useState } from "react";
import type { OrganizationRole } from "@/lib/permissions";
import { inviteMember } from "@/lib/api/org";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  open: boolean;
  onClose: () => void;
  onInvited: () => void;
};

export function InviteMemberDialog({ open, onClose, onInvited }: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<OrganizationRole>("employee");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await inviteMember({ name, email, password, role });
      setName("");
      setEmail("");
      setPassword("");
      setRole("employee");
      onInvited();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite member");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite team member</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <label className="block text-sm font-medium">
            Name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm font-medium">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm font-medium">
            Temporary password
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm font-medium">
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as OrganizationRole)}
              className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
            >
              <option value="employee">Employee</option>
              <option value="sub_admin">Sub-admin</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-foreground py-2 text-sm font-medium text-background disabled:opacity-60"
          >
            {submitting ? "Inviting…" : "Invite member"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
