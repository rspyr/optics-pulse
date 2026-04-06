import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
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
  const notificationListener = useRef<ReturnType<typeof Notifications.addNotificationReceivedListener> | null>(null);
  const responseListener = useRef<ReturnType<typeof Notifications.addNotificationResponseReceivedListener> | null>(null);

  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        if (Platform.OS !== "android" && Platform.OS !== "ios") return;

        if (!Device.isDevice) {
          console.log("[Push] Skipping registration — not a physical device");
          return;
        }

        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("default", {
            name: "Default",
            importance: Notifications.AndroidImportance.MAX,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: "#F20505",
            sound: "default",
          });
        }

        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== "granted") {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        if (finalStatus !== "granted") {
          console.log("[Push] Permission not granted");
          return;
        }

        const easProjectId = Constants.easConfig?.projectId;
        const extraProjectId = Constants.expoConfig?.extra?.eas?.projectId;
        const rawProjectId = extraProjectId ?? easProjectId;

        const projectId =
          rawProjectId && rawProjectId !== "YOUR_EAS_PROJECT_ID"
            ? rawProjectId
            : undefined;

        const tokenData = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined
        );
        const token = tokenData.data;
        setExpoPushToken(token);

        await SecureStore.setItemAsync("pulse_push_token", token);

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
        notificationListener.current.remove();
      }
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [user?.id]);

  return { expoPushToken };
}
