import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { changePassword, updateProfile } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/AuthContext";
import { STUDIO_ACCENTS, useStudioTheme, type StudioAccent } from "@/lib/studio-theme";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SettingsSheet({ open, onOpenChange }: Props) {
  const { user, organization, refreshSession } = useAuth();
  const { accent, setAccent } = useStudioTheme();

  const [name, setName] = useState(user?.name ?? "");
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    if (open && user) setName(user.name);
  }, [open, user]);

  const saveProfile = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name is required");
      return;
    }
    setSavingProfile(true);
    try {
      await updateProfile(trimmed);
      await refreshSession();
      toast.success("Profile updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update profile");
    } finally {
      setSavingProfile(false);
    }
  };

  const submitPassword = async () => {
    if (!currentPassword || !newPassword) {
      toast.error("Enter current and new password");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    setChangingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      toast.success("Password changed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-full max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Manage your account and accent color.</SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-8">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Profile</h3>
            <label className="block text-xs text-muted-foreground">Display name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
            <p className="text-xs text-muted-foreground">{user?.email}</p>
            <button
              type="button"
              onClick={saveProfile}
              disabled={savingProfile}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {savingProfile ? "Saving…" : "Save profile"}
            </button>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Password</h3>
            <input
              type="password"
              className="input"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
            <input
              type="password"
              className="input"
              placeholder="New password (min 8 characters)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={submitPassword}
              disabled={changingPassword}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {changingPassword ? "Updating…" : "Change password"}
            </button>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Organization</h3>
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
              <p className="font-medium">{organization?.name ?? "—"}</p>
              <p className="text-xs text-muted-foreground">{organization?.slug ?? "—"}</p>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Accent</h3>
            <div className="grid grid-cols-3 gap-2">
              {STUDIO_ACCENTS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setAccent(preset.id as StudioAccent)}
                  className={`flex items-center gap-2 rounded-lg border px-2 py-2 text-xs transition ${
                    accent === preset.id
                      ? "border-primary ring-1 ring-primary"
                      : "border-border hover:border-foreground/30"
                  }`}
                >
                  <span
                    className="h-4 w-4 shrink-0 rounded-full"
                    style={{ background: preset.swatch }}
                  />
                  {preset.label}
                </button>
              ))}
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
