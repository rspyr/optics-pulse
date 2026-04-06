import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { useAuth } from "./AuthContext";

const API_BASE = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

type SocketEventHandler = (data: any) => void;

interface SocketContextType {
  connected: boolean;
  on: (event: string, handler: SocketEventHandler) => void;
  off: (event: string, handler: SocketEventHandler) => void;
}

const SocketContext = createContext<SocketContextType>({
  connected: false,
  on: () => {},
  off: () => {},
});

export function useSocket() {
  return useContext(SocketContext);
}

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { user, sessionCookie, bearerToken } = useAuth();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<any>(null);
  const listenersRef = useRef<Map<string, Set<SocketEventHandler>>>(new Map());
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const ioModuleRef = useRef<any>(null);
  const creatingRef = useRef(false);
  const generationRef = useRef(0);

  const emitReconnect = useCallback(() => {
    const handlers = listenersRef.current.get("_reconnect");
    if (handlers) {
      handlers.forEach(h => h({}));
    }
  }, []);

  const buildExtraHeaders = useCallback(() => {
    const extraHeaders: Record<string, string> = {};
    if (Platform.OS !== "web" && bearerToken) {
      extraHeaders["Authorization"] = `Bearer ${bearerToken}`;
    } else if (sessionCookie) {
      extraHeaders["Cookie"] = sessionCookie;
    }
    return extraHeaders;
  }, [bearerToken, sessionCookie]);

  const createSocket = useCallback(async (generation: number) => {
    if (socketRef.current?.connected) return;
    if (creatingRef.current) return;

    creatingRef.current = true;
    try {
      if (!ioModuleRef.current) {
        const mod = await import("socket.io-client");
        ioModuleRef.current = mod.io;
      }

      if (generation !== generationRef.current) return;

      const io = ioModuleRef.current;

      const socket = io(API_BASE, {
        path: "/api/socket.io",
        transports: Platform.OS === "web" ? ["websocket", "polling"] : ["websocket"],
        extraHeaders: buildExtraHeaders(),
        withCredentials: true,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        timeout: 20000,
      });

      if (generation !== generationRef.current) {
        socket.disconnect();
        return;
      }

      socket.on("connect", () => {
        setConnected(true);
        if (user?.tenantId) {
          socket.emit("join-tenant", user.tenantId);
        }
      });

      socket.on("disconnect", () => {
        setConnected(false);
      });

      socket.io.on("reconnect", () => {
        if (user?.tenantId) {
          socket.emit("join-tenant", user.tenantId);
        }
        emitReconnect();
      });

      const events = ["new-lead", "lead-updated", "podium-message", "hud-stats"];
      for (const event of events) {
        socket.on(event, (data: any) => {
          const handlers = listenersRef.current.get(event);
          if (handlers) {
            handlers.forEach(h => h(data));
          }
        });
      }

      socketRef.current = socket;
    } catch (err) {
      console.error("[Socket] Connection error:", err);
    } finally {
      creatingRef.current = false;
    }
  }, [buildExtraHeaders, user?.tenantId, emitReconnect]);

  useEffect(() => {
    const hasAuth = sessionCookie || bearerToken;
    if (!user || !hasAuth) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setConnected(false);
      }
      return;
    }

    const generation = ++generationRef.current;
    createSocket(generation);

    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if ((prev === "background" || prev === "inactive") && nextState === "active") {
        if (socketRef.current && !socketRef.current.connected) {
          socketRef.current.connect();
        }
      }

      if (nextState === "background" && Platform.OS !== "web") {
        socketRef.current?.disconnect();
      }
    });

    return () => {
      subscription.remove();
      generationRef.current++;
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setConnected(false);
      }
    };
  }, [user?.id, sessionCookie, bearerToken, createSocket]);

  const on = useCallback((event: string, handler: SocketEventHandler) => {
    if (!listenersRef.current.has(event)) {
      listenersRef.current.set(event, new Set());
    }
    listenersRef.current.get(event)!.add(handler);
  }, []);

  const off = useCallback((event: string, handler: SocketEventHandler) => {
    listenersRef.current.get(event)?.delete(handler);
  }, []);

  return (
    <SocketContext.Provider value={{ connected, on, off }}>
      {children}
    </SocketContext.Provider>
  );
}
