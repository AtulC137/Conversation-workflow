import { useMemo, useState } from "react";
import { FileUp, Monitor, Phone } from "lucide-react";
import { normalizePhoneKey } from "@/lib/contact-fields";

export type RunnerContact = { phoneNumber: string; fields: Record<string, string> };

type Props = {
  templateName: string;
  systemPrompt: string;
  confirmationQuestion?: string;
  canEditPrompt: boolean;
  onEditPrompt: () => void;
  onBrowserTest: () => void;
  onCallPhone: (phoneNumber: string, contactFields?: Record<string, string>) => void;
  onUploadExcel: (file: File) => Promise<{ contacts: RunnerContact[] }>;
  onStartBulkCalls: (contacts: RunnerContact[]) => Promise<void>;
  onContactsChange?: (contacts: RunnerContact[]) => void;
  campaignInfo?: {
    status: string;
    total: number;
    succeeded: number;
    failed: number;
    lastError?: string | null;
  } | null;
};

const E164_REGEX = /^\+?[1-9]\d{6,14}$/;

const PHONE_COL = /^(phone|phonenumber|mobile|mobilenumber|number|contactnumber|tel)$/i;

type RunnerContactRaw = RunnerContact & { name?: string };

function normalizeHeader(k: string) {
  return k.trim().toLowerCase().replace(/\s+/g, "");
}

function isPhoneCol(k: string) {
  return PHONE_COL.test(normalizeHeader(k));
}

function normalizeContact(raw: RunnerContactRaw): RunnerContact {
  const fields: Record<string, string> = { ...(raw.fields ?? {}) };
  if (raw.name?.trim()) {
    fields.name = raw.name.trim();
  }
  for (const [k, v] of Object.entries(fields)) {
    if (normalizeHeader(k) === "name" && v.trim()) {
      fields.name = v.trim();
    }
  }
  return { phoneNumber: raw.phoneNumber, fields };
}

function contactName(fields: Record<string, string>): string {
  if (fields.name?.trim()) return fields.name.trim();
  for (const [k, v] of Object.entries(fields)) {
    if (!v.trim() || isPhoneCol(k)) continue;
    if (["name", "fullname", "contactname", "customername", "guest", "caller"].includes(normalizeHeader(k))) {
      return v.trim();
    }
  }
  return "";
}

export function TemplateRunner({
  templateName,
  systemPrompt,
  confirmationQuestion = "",
  canEditPrompt,
  onEditPrompt,
  onBrowserTest,
  onCallPhone,
  onUploadExcel,
  onStartBulkCalls,
  onContactsChange,
  campaignInfo = null,
}: Props) {
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [excelLoading, setExcelLoading] = useState(false);
  const [excelError, setExcelError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<RunnerContact[]>([]);
  const [bulkCalling, setBulkCalling] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const [singleName, setSingleName] = useState("");
  const [singlePhone, setSinglePhone] = useState("");
  const singlePhoneOk = useMemo(() => E164_REGEX.test(singlePhone.trim()), [singlePhone]);

  const queuedCount = contacts.length;

  return (
    <div className="flex h-full flex-col bg-muted/20">
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Template
              </div>
              <div className="mt-1 truncate text-lg font-semibold">{templateName}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onBrowserTest}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-2 text-xs font-medium hover:border-foreground/30 hover:shadow-sm"
              >
                <Monitor className="h-3.5 w-3.5" /> Browser test
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <section className="rounded-xl border border-border bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">Call info</div>
                <button
                  type="button"
                  onClick={onEditPrompt}
                  disabled={!canEditPrompt}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  Edit
                </button>
              </div>
              <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-foreground">
                {systemPrompt?.trim() ? systemPrompt : "No call info set."}
              </div>
              <div className="mt-3">
                <div className="text-xs font-semibold text-muted-foreground">Confirmation</div>
                <div className="mt-1 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs">
                  {confirmationQuestion.trim()
                    ? confirmationQuestion
                    : "None — confirm step skipped"}
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-border bg-white p-4">
              <div className="text-sm font-semibold">Upload Excel (bulk calls)</div>
              <p className="mt-1 text-xs text-muted-foreground">
                One row = one person. Headers become fields (and{" "}
                <code className="rounded bg-muted px-1">{"{{column}}"}</code> placeholders). Need a
                phone column. Examples:{" "}
                <code className="rounded bg-muted px-1">{"{{name}}"}</code>,{" "}
                <code className="rounded bg-muted px-1">{"{{loan_remaining}}"}</code>,{" "}
                <code className="rounded bg-muted px-1">{"{{installment}}"}</code>.
              </p>

              <div className="mt-3 flex items-center gap-2">
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => {
                    setExcelError(null);
                    setBulkError(null);
                    const f = e.target.files?.[0] ?? null;
                    setExcelFile(f);
                  }}
                  className="block w-full text-xs"
                />
                <button
                  type="button"
                  disabled={!excelFile || excelLoading}
                  onClick={async () => {
                    if (!excelFile) return;
                    setExcelLoading(true);
                    setExcelError(null);
                    try {
                      const res = await onUploadExcel(excelFile);
                      const next = res.contacts.map(normalizeContact);
                      setContacts(next);
                      onContactsChange?.(next);
                    } catch (err) {
                      setContacts([]);
                      setExcelError(err instanceof Error ? err.message : "Upload failed");
                    } finally {
                      setExcelLoading(false);
                    }
                  }}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-xs font-medium text-background disabled:opacity-50"
                >
                  <FileUp className="h-3.5 w-3.5" />
                  {excelLoading ? "Uploading…" : "Upload"}
                </button>
              </div>
              {excelError && <p className="mt-2 text-xs text-red-600">{excelError}</p>}

              <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  Queued contacts: <span className="font-semibold text-foreground">{queuedCount}</span>
                </div>
                <button
                  type="button"
                  disabled={queuedCount === 0 || bulkCalling}
                  onClick={async () => {
                    setBulkCalling(true);
                    setBulkError(null);
                    try {
                      await onStartBulkCalls(contacts);
                    } catch (err) {
                      setBulkError(err instanceof Error ? err.message : "Bulk calling failed");
                    } finally {
                      setBulkCalling(false);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-2 text-xs font-medium hover:border-foreground/30 hover:shadow-sm disabled:opacity-50"
                >
                  <Phone className="h-3.5 w-3.5" />
                  {bulkCalling ? "Calling…" : "Start bulk calls"}
                </button>
              </div>
              {bulkError && <p className="mt-2 text-xs text-red-600">{bulkError}</p>}

              {queuedCount > 0 && (
                <div className="mt-3 max-h-40 overflow-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b border-border">
                        <th className="px-3 py-2 text-left font-semibold">Name</th>
                        <th className="px-3 py-2 text-left font-semibold">Phone</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contacts.slice(0, 100).map((c, i) => (
                        <tr key={`${c.phoneNumber}-${i}`} className="border-b border-border/60">
                          <td className="px-3 py-2">{contactName(c.fields ?? {}) || "-"}</td>
                          <td className="px-3 py-2 font-mono">{c.phoneNumber}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <div className="mt-4 rounded-xl border border-border bg-white p-4">
            <div className="text-sm font-semibold">Manual call</div>
            <p className="mt-1 text-xs text-muted-foreground">Call one user (name + number).</p>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              <input
                value={singleName}
                onChange={(e) => setSingleName(e.target.value)}
                placeholder="Name"
                className="input"
              />
              <input
                value={singlePhone}
                onChange={(e) => setSinglePhone(e.target.value)}
                placeholder="+919876543210"
                className="input font-mono"
              />
              <button
                type="button"
                disabled={!singlePhoneOk}
                onClick={() => {
                  const fields: Record<string, string> = {};
                  const matched = contacts.find(
                    (c) => normalizePhoneKey(c.phoneNumber) === normalizePhoneKey(singlePhone),
                  );
                  if (matched?.fields) Object.assign(fields, matched.fields);
                  if (singleName.trim()) fields.name = singleName.trim();
                  onCallPhone(singlePhone.trim(), fields);
                }}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-xs font-medium text-background disabled:opacity-50"
              >
                <Phone className="h-3.5 w-3.5" /> Call
              </button>
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground">
              Using E.164 format. Name is optional (used only for display).
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-border bg-white p-4">
            <div className="text-sm font-semibold">Call info</div>
            {!campaignInfo ? (
              <p className="mt-1 text-xs text-muted-foreground">No campaign running.</p>
            ) : (
              <div className="mt-2 grid gap-2 text-xs md:grid-cols-4">
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Status
                  </div>
                  <div className="mt-0.5 font-semibold">{campaignInfo.status}</div>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Total
                  </div>
                  <div className="mt-0.5 font-semibold tabular-nums">{campaignInfo.total}</div>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Success
                  </div>
                  <div className="mt-0.5 font-semibold tabular-nums">{campaignInfo.succeeded}</div>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Failed
                  </div>
                  <div className="mt-0.5 font-semibold tabular-nums">{campaignInfo.failed}</div>
                </div>
                {campaignInfo.lastError ? (
                  <div className="md:col-span-4">
                    <div className="mt-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800">
                      {campaignInfo.lastError}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

