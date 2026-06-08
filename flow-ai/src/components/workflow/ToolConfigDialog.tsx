import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  open: boolean;
  initialValue: string;
  onClose: () => void;
  onSave: (value: string) => void;
};

export function ToolConfigDialog({ open, initialValue, onClose, onSave }: Props) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue, open]);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>WhatsApp Agent</DialogTitle>
          <DialogDescription>
            Enter the WhatsApp Business number for this workflow.
          </DialogDescription>
        </DialogHeader>

        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="+91 9876543210"
          className="input"
          autoFocus
        />

        <DialogFooter>
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            Cancel
          </button>
          <button
            disabled={!canSave}
            onClick={() => onSave(trimmed)}
            className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
