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
}

const AuthContext = createContext<AuthContextType | null>(null);

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null);

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
    <AuthContext.Provider value={{ user, loading, login, logout, isAgency, isClient, selectedTenantId, setSelectedTenantId, effectiveTenantId }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
