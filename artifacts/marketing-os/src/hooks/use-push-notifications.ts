import { useState, useEffect, useCallback, useRef } from "react";

const API = import.meta.env.VITE_API_URL || "";
const BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export type PushPermissionState = "default" | "granted" | "denied" | "unsupported";

export function usePushNotifications() {
  const [permission, setPermission] = useState<PushPermissionState>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const vapidKeyRef = useRef<string | null>(null);

  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  useEffect(() => {
    if (!supported) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission as PushPermissionState);

    navigator.serviceWorker.getRegistration(`${BASE_URL}/sw.js`).then(async (reg) => {
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      setSubscribed(!!sub);
    }).catch(() => {});
  }, [supported]);

  const fetchVapidKey = useCallback(async (): Promise<string | null> => {
    if (vapidKeyRef.current) return vapidKeyRef.current;
    try {
      const res = await fetch(`${API}/api/web-push/vapid-public-key`, { credentials: "include" });
      if (!res.ok) return null;
      const data = await res.json();
      vapidKeyRef.current = data.publicKey;
      return data.publicKey;
    } catch {
      return null;
    }
  }, []);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
    setLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm as PushPermissionState);
      if (perm !== "granted") {
        setLoading(false);
        return false;
      }

      const vapidKey = await fetchVapidKey();
      if (!vapidKey) {
        console.error("[PushNotif] No VAPID key available");
        setLoading(false);
        return false;
      }

      const reg = await navigator.serviceWorker.register(`${BASE_URL}/sw.js`, { scope: `${BASE_URL}/` });
      await navigator.serviceWorker.ready;

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          // Cast to BufferSource: the helper returns Uint8Array<ArrayBufferLike>
          // but lib.dom expects ArrayBufferView<ArrayBuffer>; runtime is identical.
          applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
        });
      }

      const res = await fetch(`${API}/api/web-push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });

      if (res.ok) {
        setSubscribed(true);
        setLoading(false);
        return true;
      }

      setLoading(false);
      return false;
    } catch (err) {
      console.error("[PushNotif] Subscribe error:", err);
      setLoading(false);
      return false;
    }
  }, [supported, fetchVapidKey]);

  const unsubscribe = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration(`${BASE_URL}/sw.js`);
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          const res = await fetch(`${API}/api/web-push/unsubscribe`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
          if (!res.ok) {
            console.error("[PushNotif] Server unsubscribe failed:", res.status);
            setLoading(false);
            return false;
          }
          await sub.unsubscribe();
        }
      }
      setSubscribed(false);
      setLoading(false);
      return true;
    } catch (err) {
      console.error("[PushNotif] Unsubscribe error:", err);
      setLoading(false);
      return false;
    }
  }, [supported]);

  return { permission, subscribed, loading, supported, subscribe, unsubscribe };
}
