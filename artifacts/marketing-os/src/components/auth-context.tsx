import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

interface LeaderboardConfig {
  visible: boolean;
  displayMode: "named" | "anonymized";
}

interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: "super_admin" | "agency_user" | "client_admin" | "client_user";
  tenantId: number | null;
  tenantName: string | null;
  leaderboardConfig: LeaderboardConfig | null;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  isAgency: boolean;
  isClient: boolean;
  selectedTenantId: number | null;
  setSelectedTenantId: (id: number | null) => void;
  effectiveTenantId: number | null;
  // True once the operator has explicitly chosen a tenant or "All Tenants"
  // (i.e. the choice is persisted). Pages that auto-pick a default tenant
  // (e.g. /pulse, /clients) should respect this flag and skip their default
  // when it's true and `selectedTenantId === null` — that means the operator
  // explicitly asked for the agency-wide view.
  tenantSelectionMade: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

// Shared storage key for the Agency God View tenant filter. The same key is
// read/written by every admin surface (Agency God View, Attribution, Admin
// Tenants list, etc.) so the operator's choice survives navigation and reload.
// Values: a numeric tenant id, the string "all" (explicit All Tenants), or
// missing (no choice yet — pages may auto-pick a default).
const TENANT_FILTER_STORAGE_KEY = "agencyGodView.tenantId";

interface PersistedTenant {
  id: number | null;
  set: boolean;
}

function readPersistedTenantId(): PersistedTenant {
  if (typeof window === "undefined") return { id: null, set: false };
  try {
    const raw = window.localStorage.getItem(TENANT_FILTER_STORAGE_KEY);
    if (raw == null) return { id: null, set: false };
    if (raw === "all") return { id: null, set: true };
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return { id: n, set: true };
    return { id: null, set: false };
  } catch {
    return { id: null, set: false };
  }
}

function writePersistedTenantId(id: number | null): void {
  if (typeof window === "undefined") return;
  try {
    // We always record the operator's choice, including the explicit "All
    // Tenants" decision — pages that auto-pick a default need to know the
    // difference between "never set" and "explicitly all".
    if (id == null) window.localStorage.setItem(TENANT_FILTER_STORAGE_KEY, "all");
    else window.localStorage.setItem(TENANT_FILTER_STORAGE_KEY, String(id));
  } catch { /* ignore quota / disabled storage */ }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [{ id: selectedTenantId, set: tenantSelectionMade }, setPersistedTenantState] = useState<PersistedTenant>(
    () => readPersistedTenantId(),
  );
  const setSelectedTenantId = useCallback((id: number | null) => {
    setPersistedTenantState({ id, set: true });
    writePersistedTenantId(id);
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/me`, { credentials: "include" })
      .then(res => {
        if (res.ok) return res.json();
        return null;
      })
      .then(data => {
        if (data && data.id) setUser(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<AuthUser> => {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      credentials: "include",
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Login failed");
    }
    const data = await res.json();
    setUser(data);
    return data;
  }, []);

  const logout = useCallback(async () => {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    setUser(null);
  }, []);

  const isAgency = user?.role === "super_admin" || user?.role === "agency_user";
  const isClient = user?.role === "client_admin" || user?.role === "client_user";
  const effectiveTenantId = user?.tenantId ?? selectedTenantId;

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, isAgency, isClient, selectedTenantId, setSelectedTenantId, effectiveTenantId, tenantSelectionMade }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
