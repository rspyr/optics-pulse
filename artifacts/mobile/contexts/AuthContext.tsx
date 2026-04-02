import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const API_BASE = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  tenantId?: number | null;
  tenantName?: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  sessionCookie: string | null;
  bearerToken: string | null;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: async () => ({ success: false }),
  logout: async () => {},
  sessionCookie: null,
  bearerToken: null,
});

export function useAuth() {
  return useContext(AuthContext);
}

async function storeValue(key: string, value: string) {
  if (Platform.OS === "web") {
    try { localStorage.setItem(key, value); } catch {}
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}

async function getValue(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  return SecureStore.getItemAsync(key);
}

async function removeValue(key: string) {
  if (Platform.OS === "web") {
    try { localStorage.removeItem(key); } catch {}
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}

function extractSetCookie(headers: Headers): string | null {
  const raw = headers.get("set-cookie");
  if (!raw) return null;
  const match = raw.match(/mos\.sid=[^;]+/);
  return match ? match[0] : null;
}

function extractBearerFromCookie(cookieStr: string): string | null {
  const match = cookieStr.match(/^mos\.sid=(.+)$/);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  return null;
}

function buildAuthHeaders(bearerToken: string | null, sessionCookie: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (Platform.OS !== "web" && bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  } else if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }
  return headers;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionCookie, setSessionCookie] = useState<string | null>(null);
  const [bearerToken, setBearerToken] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const storedToken = await getValue("pulse_bearer_token");
        const storedCookie = await getValue("pulse_session");

        if (storedToken || storedCookie) {
          if (storedToken) setBearerToken(storedToken);
          if (storedCookie) setSessionCookie(storedCookie);

          const authHeaders: Record<string, string> = {};
          if (Platform.OS !== "web" && storedToken) {
            authHeaders["Authorization"] = `Bearer ${storedToken}`;
          } else if (storedCookie) {
            authHeaders["Cookie"] = storedCookie;
          }

          const res = await fetch(`${API_BASE}/api/auth/me`, {
            credentials: "include",
            headers: authHeaders,
          });
          if (res.ok) {
            const data = await res.json();
            setUser(data);
          } else {
            await removeValue("pulse_session");
            await removeValue("pulse_bearer_token");
            setSessionCookie(null);
            setBearerToken(null);
          }
        }
      } catch (err) {
        console.error("[Auth] Session check failed:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const errorBody = err as { error?: string };
        return { success: false, error: errorBody.error || "Login failed" };
      }

      const data = await res.json();

      if (data.bearerToken) {
        setBearerToken(data.bearerToken);
        await storeValue("pulse_bearer_token", data.bearerToken);
      }

      const cookie = data.sessionToken || extractSetCookie(res.headers);
      if (cookie) {
        setSessionCookie(cookie);
        await storeValue("pulse_session", cookie);

        if (!data.bearerToken) {
          const extracted = extractBearerFromCookie(cookie);
          if (extracted) {
            setBearerToken(extracted);
            await storeValue("pulse_bearer_token", extracted);
          }
        }
      }

      setUser(data as AuthUser);
      return { success: true };
    } catch (err) {
      return { success: false, error: "Network error" };
    }
  }, []);

  const logout = useCallback(async () => {
    const headers: Record<string, string> = buildAuthHeaders(bearerToken, sessionCookie);

    try {
      const storedPushToken = await getValue("pulse_push_token");
      if (storedPushToken) {
        await fetch(`${API_BASE}/api/push-tokens`, {
          method: "DELETE",
          credentials: "include",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ token: storedPushToken }),
        }).catch(() => {});
        await removeValue("pulse_push_token");
      }
    } catch {}

    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers,
      });
    } catch {}
    setUser(null);
    setSessionCookie(null);
    setBearerToken(null);
    await removeValue("pulse_session");
    await removeValue("pulse_bearer_token");
  }, [sessionCookie, bearerToken]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, sessionCookie, bearerToken }}>
      {children}
    </AuthContext.Provider>
  );
}
