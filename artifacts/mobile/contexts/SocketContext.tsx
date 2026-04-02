import React, { createContext, useContext, useEffect, useRef, useState } from "react";
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
  const { user, sessionCookie } = useAuth();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<any>(null);
  const listenersRef = useRef<Map<string, Set<SocketEventHandler>>>(new Map());

  useEffect(() => {
    if (!user || !sessionCookie) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setConnected(false);
      }
      return;
    }

    let isMounted = true;

    (async () => {
      try {
        const { io } = await import("socket.io-client");
        if (!isMounted) return;

        const socket = io(API_BASE, {
          path: "/api/socket.io",
          transports: ["websocket", "polling"],
          extraHeaders: { Cookie: sessionCookie },
          withCredentials: true,
        });

        socket.on("connect", () => {
          if (isMounted) setConnected(true);
          if (user.tenantId) {
            socket.emit("join-tenant", user.tenantId);
          }
        });

        socket.on("disconnect", () => {
          if (isMounted) setConnected(false);
        });

        const events = ["new-lead", "lead-updated", "podium-message"];
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
      }
    })();

    return () => {
      isMounted = false;
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setConnected(false);
      }
    };
  }, [user?.id, sessionCookie]);

  const on = (event: string, handler: SocketEventHandler) => {
    if (!listenersRef.current.has(event)) {
      listenersRef.current.set(event, new Set());
    }
    listenersRef.current.get(event)!.add(handler);
  };

  const off = (event: string, handler: SocketEventHandler) => {
    listenersRef.current.get(event)?.delete(handler);
  };

  return (
    <SocketContext.Provider value={{ connected, on, off }}>
      {children}
    </SocketContext.Provider>
  );
}
