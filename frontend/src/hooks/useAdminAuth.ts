import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type { AdminUser } from "../types";

const KEY = "djclaude.admin_token";

// useAdminAuth: localStorage-backed admin session token + the logged-in user.
// Triggers a re-render when login/logout happens via custom events so
// every consumer stays in sync.
export function useAdminAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(KEY));
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }
    let alive = true;
    setLoading(true);
    api.adminMe(token)
      .then((u) => { if (alive) setUser(u); })
      .catch(() => {
        // Token rejected — clear and force re-login.
        if (!alive) return;
        localStorage.removeItem(KEY);
        setToken(null);
        setUser(null);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token]);

  return {
    token,
    user,
    loading,
    error,
    async login(username: string, password: string) {
      setError(null);
      try {
        const r = await api.adminLogin(username, password);
        localStorage.setItem(KEY, r.token);
        setToken(r.token);
        return r;
      } catch (e: any) {
        setError(e?.message ?? "login failed");
        throw e;
      }
    },
    async logout() {
      if (token) await api.adminLogout(token).catch(() => {});
      localStorage.removeItem(KEY);
      setToken(null);
      setUser(null);
    },
  };
}
