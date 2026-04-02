import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useApi } from "@/hooks/useApi";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export function usePushNotifications() {
  const { user } = useAuth();
  const { apiFetch } = useApi();
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const notificationListener = useRef<Notifications.EventSubscription>();
  const responseListener = useRef<Notifications.EventSubscription>();

  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        if (Platform.OS === "web") return;

        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== "granted") {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        if (finalStatus !== "granted") return;

        const tokenData = await Notifications.getExpoPushTokenAsync();
        const token = tokenData.data;
        setExpoPushToken(token);

        if (Platform.OS !== "web") {
          await SecureStore.setItemAsync("pulse_push_token", token);
        } else {
          try { localStorage.setItem("pulse_push_token", token); } catch {}
        }

        let registered = false;
        for (let attempt = 0; attempt < 3 && !registered; attempt++) {
          try {
            await apiFetch("/api/push-tokens", {
              method: "POST",
              body: JSON.stringify({ token, platform: Platform.OS }),
            });
            registered = true;
          } catch (regErr) {
            console.warn(`[Push] Registration attempt ${attempt + 1} failed:`, regErr);
            if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          }
        }
      } catch (err) {
        console.error("[Push] Registration error:", err);
      }
    })();

    notificationListener.current = Notifications.addNotificationReceivedListener((notification) => {
      console.log("[Push] Notification received:", notification.request.content.title);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      if (data?.leadId) {
        router.push({ pathname: "/lead/[id]", params: { id: String(data.leadId) } });
      }
    });

    return () => {
      if (notificationListener.current) {
        Notifications.removeNotificationSubscription(notificationListener.current);
      }
      if (responseListener.current) {
        Notifications.removeNotificationSubscription(responseListener.current);
      }
    };
  }, [user?.id]);

  return { expoPushToken };
}
