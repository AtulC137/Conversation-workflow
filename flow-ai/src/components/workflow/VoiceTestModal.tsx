import { useEffect, useState } from "react";
import { Monitor, Phone } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type VoiceTestMode = "browser" | "phone";

type Props = {
  open: boolean;
  loading?: boolean;
  onClose: () => void;
  onTest: (mode: VoiceTestMode, phoneNumber?: string) => void;
};

const E164_REGEX = /^\+?[1-9]\d{6,14}$/;

export function VoiceTestModal({ open, loading = false, onClose, onTest }: Props) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPhoneError(null);
    }
  }, [open]);

  const validatePhone = () => {
    const trimmed = phoneNumber.trim();
    if (!trimmed) {
      setPhoneError("Enter a phone number to call");
      return null;
    }
    if (!E164_REGEX.test(trimmed)) {
      setPhoneError("Use E.164 format, e.g. +919876543210");
      return null;
    }
    setPhoneError(null);
    return trimmed;
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !loading && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Test Voice Workflow</DialogTitle>
          <DialogDescription>
            Call your phone via SIP trunk, or test with your browser microphone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="voice-test-phone">
            Phone number (for call test)
          </label>
          <input
            id="voice-test-phone"
            type="tel"
            value={phoneNumber}
            onChange={(e) => {
              setPhoneNumber(e.target.value);
              setPhoneError(null);
            }}
            placeholder="+919876543210"
            className="input w-full"
            disabled={loading}
          />
          {phoneError ? (
            <p className="text-xs text-red-600">{phoneError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Include country code. Your phone will be called via the SIP trunk.
            </p>
          )}
        </div>

        {loading && (
          <p className="text-xs text-muted-foreground">Creating session…</p>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => onTest("browser")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            <Monitor className="h-3.5 w-3.5" />
            {loading ? "Creating session…" : "Test in browser"}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              const phone = validatePhone();
              if (phone) onTest("phone", phone);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
          >
            <Phone className="h-3.5 w-3.5" />
            {loading ? "Calling…" : "Call my phone"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
