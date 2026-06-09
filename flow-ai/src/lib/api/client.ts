const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export type ApiUser = {
  id: string;
  email: string;
  name: string;
};

type AuthResponse = {
  accessToken: string;
  user: ApiUser;
};

let accessToken: string | null =
  typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
  if (typeof window !== "undefined") {
    if (token) localStorage.setItem("accessToken", token);
    else localStorage.removeItem("accessToken");
  }
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
    throw new Error(typeof err.error === "string" ? err.error : "Request failed");
  }

  return res.json() as Promise<T>;
}

export async function registerUser(email: string, password: string, name: string) {
  const data = await apiFetch<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
  setAccessToken(data.accessToken);
  return data;
}

export async function loginUser(email: string, password: string) {
  const data = await apiFetch<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setAccessToken(data.accessToken);
  return data;
}

export async function refreshAccessToken() {
  try {
    const data = await apiFetch<AuthResponse>(
      "/api/auth/refresh",
      { method: "POST" },
      false,
    );
    setAccessToken(data.accessToken);
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
  return apiFetch<{ user: ApiUser }>("/api/auth/me");
}
