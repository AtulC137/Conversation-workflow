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

export function ContextConfigDialog({ open, initialValue, onClose, onSave }: Props) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue, open]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Workflow Context</DialogTitle>
          <DialogDescription>
            Facts shared by Voice and WhatsApp agents — amounts, dates, policies, clinic hours,
            etc.
          </DialogDescription>
        </DialogHeader>

        <textarea
          rows={8}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Bank of Maharashtra loan for Atul. Monthly payment 8500 rupees. Remaining 17000. Late fine 1000. Due 10 June 2026."
          className="input resize-none leading-relaxed"
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
            onClick={() => onSave(value.trim())}
            className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
          >
            Save
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
