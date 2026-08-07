import * as XLSX from "xlsx";

const E164_REGEX = /^\+?[1-9]\d{6,14}$/;

const PHONE_HEADER_KEYS = new Set([
  "phonenumber",
  "phone",
  "mobile",
  "mobilenumber",
  "number",
  "contactnumber",
  "tel",
]);

const NAME_HEADER_KEYS = new Set([
  "name",
  "fullname",
  "contactname",
  "customername",
  "guest",
  "caller",
]);

export type ContactFields = Record<string, string>;

export type ParsedContact = {
  phoneNumber: string;
  fields: ContactFields;
};

export type VoiceSessionConfigInput = {
  context: string;
  example: string;
  endPoints: string[];
  greeting: string | null;
  graph: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
};

export function normalizeHeaderKey(k: string) {
  return k.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function headerLabel(rawKey: string) {
  const trimmed = rawKey.trim();
  return trimmed || rawKey;
}

function isPhoneHeader(key: string) {
  return PHONE_HEADER_KEYS.has(normalizeHeaderKey(key));
}

function isNameHeader(key: string) {
  return NAME_HEADER_KEYS.has(normalizeHeaderKey(key));
}

function canonicalizeFields(fields: ContactFields): ContactFields {
  const out = { ...fields };
  for (const [k, v] of Object.entries(fields)) {
    if (isNameHeader(k) && v.trim()) {
      out.name = v.trim();
      break;
    }
  }
  return out;
}

export function normalizeContactFields(fields: ContactFields): ContactFields {
  return canonicalizeFields(fields);
}

export function normalizePhoneKey(phone: string): string {
  return phone.trim().replace(/[\s-]/g, "");
}

function parseSheetMatrix(ws: XLSX.WorkSheet): ParsedContact[] {
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false }) as unknown[][];
  if (!matrix.length) return [];

  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(matrix.length, 8); i++) {
    const row = matrix[i] as unknown[];
    const labels = row.map((cell) => normalizeHeaderKey(String(cell ?? "")));
    if (labels.some((label) => label && isPhoneHeader(label))) {
      headerRowIdx = i;
      break;
    }
  }

  const headers = (matrix[headerRowIdx] as unknown[]).map((cell) => headerLabel(String(cell ?? "")));
  const contacts: ParsedContact[] = [];

  for (let r = headerRowIdx + 1; r < matrix.length; r++) {
    const row = matrix[r] as unknown[];
    if (!row?.length) continue;

    const fields: ContactFields = {};
    let phoneNumber = "";

    for (let c = 0; c < headers.length; c++) {
      const label = headers[c];
      if (!label) continue;
      const val = String(row[c] ?? "").trim();
      if (!val) continue;
      fields[label] = val;
      if (!phoneNumber && isPhoneHeader(label)) {
        phoneNumber = val;
      }
    }

    if (!phoneNumber || !E164_REGEX.test(phoneNumber)) continue;
    contacts.push({ phoneNumber, fields: canonicalizeFields(fields) });
  }

  return contacts;
}

function resolveField(fields: ContactFields, rawKey: string): string | undefined {
  const norm = normalizeHeaderKey(rawKey);
  for (const [k, v] of Object.entries(fields)) {
    if (normalizeHeaderKey(k) === norm) return v;
  }
  const fallbacks: Record<string, string[]> = {
    name: ["caller", "guest", "customer", "fullname", "contactname", "customername"],
  };
  for (const alt of fallbacks[norm] ?? []) {
    for (const [k, v] of Object.entries(fields)) {
      if (normalizeHeaderKey(k) === alt) return v;
    }
  }
  return undefined;
}

export function applyPlaceholders(text: string, fields: ContactFields): string {
  if (!text) return text;
  return text.replace(/\{\{\s*([a-zA-Z0-9_\s]+)\s*\}\}/g, (_match, rawKey: string) => {
    const val = resolveField(fields, rawKey);
    return val !== undefined ? val : `{{${rawKey}}}`;
  });
}

export function buildContactContextBlock(fields: ContactFields): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `- ${k}: ${v}`);
  if (!lines.length) return "";
  const caller = (fields.name ?? "").trim() || "UNKNOWN";
  return [
    "IDENTITY (critical):",
    "- AGENT_NAME: Susha (this is YOU — never the caller's name)",
    `- CALLER_NAME: ${caller}`,
    "- If asked the caller's name, answer CALLER_NAME only. Never say the caller is Susha.",
    "CONTACT DATA (this call only — column headers describe each value):",
    ...lines,
  ].join("\n");
}

/** Placeholder key for a column header, e.g. "Loan Remaining" → "loan_remaining". */
export function placeholderKeyForHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildExcelFieldsHint(fields: ContactFields): string {
  const caller = (fields.name ?? "").trim() || "(unknown)";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!v.trim() || isPhoneHeader(k)) continue;
    const ph = placeholderKeyForHeader(k);
    parts.push(`${k}=${v.trim()} ({{${ph}}})`);
  }
  const fieldLine = parts.length
    ? `Available fields (use as facts): ${parts.join("; ")}`
    : "Available fields: (none)";
  return [
    `Caller: ${caller}`,
    "You are Susha (agent). NEVER address the caller as Susha. Address them by Caller name above.",
    fieldLine,
  ].join("\n");
}

function mapGraphNode(node: Record<string, unknown>, fields: ContactFields) {
  const out = { ...node };
  const data =
    out.data && typeof out.data === "object" && !Array.isArray(out.data)
      ? { ...(out.data as Record<string, unknown>) }
      : null;

  for (const key of ["message", "instruction", "replyGuide", "title"] as const) {
    const top = out[key];
    if (typeof top === "string" && top.trim()) {
      out[key] = applyPlaceholders(top, fields);
    }
    if (data && typeof data[key] === "string" && String(data[key]).trim()) {
      data[key] = applyPlaceholders(String(data[key]), fields);
    }
  }

  const hint = buildExcelFieldsHint(fields);
  const nodeType = out.type ?? data?.type;
  const injectInto = (target: Record<string, unknown>) => {
    if (typeof target.instruction !== "string") return;
    if (String(target.instruction).includes("Available fields (use as facts):")) return;
    target.instruction = `${String(target.instruction).trim()}\n\n${hint}`;
  };

  if (nodeType === "userInput") {
    if (data) injectInto(data);
    else injectInto(out);
  }

  if (data) out.data = data;
  return out;
}

export function mergeSessionWithContact<T extends VoiceSessionConfigInput>(
  config: T,
  fields: ContactFields,
): T {
  const normalized = normalizeContactFields(fields);
  if (!Object.keys(normalized).length) return config;

  const contactBlock = buildContactContextBlock(normalized);
  const context = contactBlock
    ? `${config.context.trim()}\n\n${contactBlock}`.trim()
    : config.context;

  return {
    ...config,
    context,
    greeting: config.greeting ? applyPlaceholders(config.greeting, normalized) : null,
    graph: {
      nodes: config.graph.nodes.map((n) =>
        mapGraphNode(n as Record<string, unknown>, normalized),
      ),
      edges: config.graph.edges,
    },
  } as T;
}

export function parseContactsFromWorkbook(buffer: Buffer): ParsedContact[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const ws = wb.Sheets[sheetName];

  const contacts = parseSheetMatrix(ws);
  if (contacts.length) {
    const seen = new Set<string>();
    return contacts.filter((c) => {
      const key = c.phoneNumber.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Fallback: first row is headers (simple sheets)
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "", blankrows: false }) as Record<string, unknown>[];
  const fallback: ParsedContact[] = [];
  for (const row of rows) {
    const fields: ContactFields = {};
    let phoneNumber = "";

    for (const [rawKey, rawVal] of Object.entries(row)) {
      const val = String(rawVal ?? "").trim();
      if (!val) continue;
      const label = headerLabel(rawKey);
      fields[label] = val;
      if (!phoneNumber && isPhoneHeader(rawKey)) {
        phoneNumber = val;
      }
    }

    if (!phoneNumber || !E164_REGEX.test(phoneNumber)) continue;
    fallback.push({ phoneNumber, fields: canonicalizeFields(fields) });
  }

  const seen = new Set<string>();
  return fallback.filter((c) => {
    const key = c.phoneNumber.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
