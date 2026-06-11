export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function slugFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return slugify(local) || "org";
}
