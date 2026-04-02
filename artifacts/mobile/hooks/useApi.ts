import { useCallback } from "react";
import { Platform } from "react-native";
import { useAuth } from "@/contexts/AuthContext";

const API_BASE = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

export function useApi() {
  const { sessionCookie, bearerToken } = useAuth();

  const apiFetch = useCallback(async (path: string, options: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> || {}),
    };
    if (Platform.OS !== "web" && bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    } else if (sessionCookie) {
      headers["Cookie"] = sessionCookie;
    }
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Request failed" }));
      const errorBody = err as { error?: string };
      throw new Error(errorBody.error || `HTTP ${res.status}`);
    }
    return res.json();
  }, [sessionCookie, bearerToken]);

  return { apiFetch };
}
