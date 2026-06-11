import type { ApiOrganization, OrganizationRole, PermissionsMap } from "@/lib/permissions";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export type ApiUser = {
  id: string;
  email: string;
  name: string;
};

export type AuthSession = {
  user: ApiUser;
  organization: ApiOrganization;
  role: OrganizationRole;
  permissions: PermissionsMap;
};

type AuthResponse = AuthSession & {
  accessToken: string;
};

type MeResponse = AuthSession;

let accessToken: string | null =
  typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;

let sessionCache: AuthSession | null = null;

export function getAccessToken() {
  return accessToken;
}

export function getSession() {
  return sessionCache;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
  if (typeof window !== "undefined") {
    if (token) localStorage.setItem("accessToken", token);
    else localStorage.removeItem("accessToken");
  }
  if (!token) sessionCache = null;
}

function applyAuthResponse(data: AuthResponse) {
  setAccessToken(data.accessToken);
  sessionCache = {
    user: data.user,
    organization: data.organization,
    role: data.role,
    permissions: data.permissions,
  };
  return sessionCache;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  if (res.status === 401 && retry && path !== "/api/auth/refresh") {
    const refreshed = await refreshAccessToken();
    if (refreshed) return apiFetch<T>(path, options, false);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const message = typeof err.error === "string" ? err.error : "Request failed";
    throw new ApiError(message, res.status, err);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export type RegisterPayload = {
  email: string;
  password: string;
  name: string;
  organizationName: string;
  organizationSlug: string;
};

export async function registerUser(payload: RegisterPayload) {
  const data = await apiFetch<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return applyAuthResponse(data);
}

export async function loginUser(organizationSlug: string, email: string, password: string) {
  const data = await apiFetch<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ organizationSlug, email, password }),
  });
  return applyAuthResponse(data);
}

export async function refreshAccessToken() {
  try {
    const data = await apiFetch<AuthResponse>(
      "/api/auth/refresh",
      { method: "POST" },
      false,
    );
    applyAuthResponse(data);
    return true;
  } catch {
    setAccessToken(null);
    return false;
  }
}

export async function logoutUser() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } finally {
    setAccessToken(null);
  }
}

export async function fetchMe() {
  const data = await apiFetch<MeResponse>("/api/auth/me");
  sessionCache = data;
  return data;
}

export async function checkSlugAvailable(slug: string) {
  return apiFetch<{ slug: string; available: boolean }>(`/api/auth/check-slug/${encodeURIComponent(slug)}`);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function updateProfile(name: string) {
  return apiFetch<{ user: ApiUser }>("/api/auth/profile", {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function changePassword(currentPassword: string, newPassword: string) {
  return apiFetch<{ ok: boolean }>("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}
