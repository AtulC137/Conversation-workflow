import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchMe,
  getAccessToken,
  loginUser,
  logoutUser,
  registerUser,
  refreshAccessToken,
  type AuthSession,
  type RegisterPayload,
} from "@/lib/api/client";
import { hasPermission, type PermissionKey } from "@/lib/permissions";

type AuthState = {
  user: AuthSession["user"] | null;
  organization: AuthSession["organization"] | null;
  role: AuthSession["role"] | null;
  permissions: AuthSession["permissions"] | null;
  loading: boolean;
  login: (organizationSlug: string, email: string, password: string) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (key: PermissionKey) => boolean;
  refreshSession: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSession = useCallback(async () => {
    if (!getAccessToken()) {
      await refreshAccessToken();
    }
    if (getAccessToken()) {
      try {
        const me = await fetchMe();
        setSession(me);
        return;
      } catch {
        setSession(null);
      }
    } else {
      setSession(null);
    }
  }, []);

  useEffect(() => {
    loadSession().finally(() => setLoading(false));
  }, [loadSession]);

  useEffect(() => {
    const onFocus = () => {
      if (getAccessToken()) {
        fetchMe()
          .then(setSession)
          .catch(() => {});
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const login = useCallback(async (organizationSlug: string, email: string, password: string) => {
    const s = await loginUser(organizationSlug, email, password);
    setSession(s);
  }, []);

  const register = useCallback(async (payload: RegisterPayload) => {
    const s = await registerUser(payload);
    setSession(s);
  }, []);

  const logout = useCallback(async () => {
    await logoutUser();
    setSession(null);
  }, []);

  const checkPermission = useCallback(
    (key: PermissionKey) => {
      if (!session) return false;
      return hasPermission(session.role, session.permissions, key);
    },
    [session],
  );

  const value = useMemo(
    () => ({
      user: session?.user ?? null,
      organization: session?.organization ?? null,
      role: session?.role ?? null,
      permissions: session?.permissions ?? null,
      loading,
      login,
      register,
      logout,
      hasPermission: checkPermission,
      refreshSession: loadSession,
    }),
    [session, loading, login, register, logout, checkPermission, loadSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
