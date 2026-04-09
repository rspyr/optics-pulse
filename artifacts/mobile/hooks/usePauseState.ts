import { useState, useCallback, useEffect } from "react";
import { useApi } from "@/hooks/useApi";
import { useTenant } from "@/contexts/TenantContext";
import { useSocket } from "@/contexts/SocketContext";
import { useAuth } from "@/contexts/AuthContext";

export function usePauseState() {
  const { apiFetch } = useApi();
  const { effectiveTenantId } = useTenant();
  const { on, off } = useSocket();
  const { user } = useAuth();
  const isClientUser = user?.role === "client_user";
  const [isPaused, setIsPaused] = useState(false);
  const [pauseSource, setPauseSource] = useState("manager");
  const [toggling, setToggling] = useState(false);

  const fetchPause = useCallback(async () => {
    if (!effectiveTenantId || !isClientUser) return;
    try {
      const data = await apiFetch(`/api/leads-hub/my-pause?tenantId=${effectiveTenantId}`);
      setIsPaused(data.isPaused);
      setPauseSource(data.pauseSource);
    } catch (e) {}
  }, [apiFetch, effectiveTenantId, isClientUser]);

  useEffect(() => { fetchPause(); }, [fetchPause]);

  useEffect(() => {
    const handler = () => { fetchPause(); };
    on("_reconnect", handler);
    return () => { off("_reconnect", handler); };
  }, [on, off, fetchPause]);

  const toggle = useCallback(async () => {
    if (toggling) return;
    setToggling(true);
    try {
      const data = await apiFetch("/api/leads-hub/my-pause", {
        method: "POST",
        body: JSON.stringify({ isPaused: !isPaused }),
      });
      setIsPaused(data.isPaused);
      setPauseSource(data.pauseSource);
    } catch (e) {
      console.error("[PauseState] toggle failed:", e);
    } finally {
      setToggling(false);
    }
  }, [apiFetch, isPaused, toggling]);

  const isManagerPaused = isPaused && pauseSource === "manager";

  return { isPaused, pauseSource, toggling, toggle, isManagerPaused, fetchPause };
}
