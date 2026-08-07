import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ContextSaveValue = {
  prompt: string;
  confirmationQuestion: string;
};

type Props = {
  open: boolean;
  initialValue: string;
  initialConfirmation?: string;
  onClose: () => void;
  onSave: (value: ContextSaveValue) => void;
};

export function ContextConfigDialog({
  open,
  initialValue,
  initialConfirmation = "",
  onClose,
  onSave,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [confirmation, setConfirmation] = useState(initialConfirmation);

  useEffect(() => {
    setValue(initialValue);
    setConfirmation(initialConfirmation);
  }, [initialValue, initialConfirmation, open]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Call info</DialogTitle>
          <DialogDescription>
            Add the facts for this call. Excel columns personalize each person with{" "}
            <code className="rounded bg-muted px-1">{"{{name}}"}</code> and other field names.
            Confirmation is optional.
          </DialogDescription>
        </DialogHeader>

        <label className="block text-xs font-medium text-muted-foreground">Prompt / facts</label>
        <textarea
          rows={7}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Company: Bank of Maharashtra&#10;Reason: loan reminder&#10;Monthly payment 8500. Remaining 17000. Due 10 June 2026."
          className="input resize-none leading-relaxed"
          autoFocus
        />

        <label className="mt-3 block text-xs font-medium text-muted-foreground">
          Confirmation question (optional)
        </label>
        <input
          type="text"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder='e.g. "Will you attend?" — leave empty to skip'
          className="input"
        />

        <DialogFooter>
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              onSave({
                prompt: value.trim(),
                confirmationQuestion: confirmation.trim(),
              })
            }
            className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
          >
            Save
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
