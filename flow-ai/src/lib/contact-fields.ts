import type { RunnerContact } from "@/components/workflow/TemplateRunner";

export function normalizePhoneKey(phone: string): string {
  return phone.trim().replace(/[\s-]/g, "");
}

export function resolveContactFields(
  contacts: RunnerContact[],
  phone?: string,
  explicit?: Record<string, string>,
): Record<string, string> | undefined {
  if (explicit && Object.keys(explicit).length > 0) return explicit;
  if (phone) {
    const norm = normalizePhoneKey(phone);
    const match = contacts.find((c) => normalizePhoneKey(c.phoneNumber) === norm);
    if (match?.fields && Object.keys(match.fields).length > 0) return match.fields;
  }
  if (contacts.length > 0 && Object.keys(contacts[0].fields ?? {}).length > 0) {
    return contacts[0].fields;
  }
  return undefined;
}
