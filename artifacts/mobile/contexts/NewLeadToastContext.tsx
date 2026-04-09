import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  AppState,
  Platform,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSocket } from "./SocketContext";
import { useAuth } from "./AuthContext";

interface ToastLead {
  id: number;
  firstName?: string;
  lastName?: string;
  source?: string;
  phone?: string;
}

interface PodiumToast {
  id: number;
  leadId?: number;
  leadName?: string;
  senderName?: string;
  body?: string;
  channelType?: string;
  direction?: string;
}

interface NewLeadToastContextType {
  recordPushLeadId: (leadId: number) => void;
}

const NewLeadToastContext = createContext<NewLeadToastContextType>({
  recordPushLeadId: () => {},
});

export function useNewLeadToast() {
  return useContext(NewLeadToastContext);
}

function PodiumToastBanner({ data, onPress, onDismiss }: { data: PodiumToast; onPress: () => void; onDismiss: () => void }) {
  const slideAnim = useRef(new Animated.Value(-120)).current;
  const progressAnim = useRef(new Animated.Value(1)).current;

  const isCall = data.channelType === "phone" || data.channelType === "call" || data.channelType === "phone_call" || data.channelType === "car_wars";

  useEffect(() => {
    Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, damping: 20, stiffness: 300 }).start();
    Animated.timing(progressAnim, { toValue: 0, duration: 15000, useNativeDriver: false }).start();
    const timer = setTimeout(onDismiss, 15000);
    return () => clearTimeout(timer);
  }, []);

  const progressWidth = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  return (
    <Animated.View style={[styles.toastContainer, { transform: [{ translateY: slideAnim }] }]}>
      <TouchableOpacity
        style={[styles.card, { backgroundColor: "#1e3a5f", borderColor: "#3b82f666" }]}
        onPress={onPress}
        activeOpacity={0.85}
      >
        <View style={styles.topRow}>
          <View style={styles.pulseWrap}>
            <View style={[styles.pulseDot, { backgroundColor: "#3b82f6" }]} />
          </View>
          <Text style={[styles.toastTitle, { color: "#60a5fa" }]}>{isCall ? "Incoming Call" : "Inbound Text"}</Text>
          <View style={styles.podiumBadge}>
            <Text style={styles.podiumBadgeText}>Podium</Text>
          </View>
          <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="x" size={16} color="rgba(255,255,255,0.4)" />
          </TouchableOpacity>
        </View>
        <Text style={styles.toastName}>{data.leadName || data.senderName || "Unknown Contact"}</Text>
        {data.body && !isCall ? (
          <Text style={styles.podiumBody} numberOfLines={2}>{data.body}</Text>
        ) : null}
        <Animated.View style={[styles.progressBar, { width: progressWidth, backgroundColor: "rgba(59,130,246,0.6)" }]} />
      </TouchableOpacity>
    </Animated.View>
  );
}

function ToastBanner({ lead, onPress, onDismiss }: { lead: ToastLead; onPress: () => void; onDismiss: () => void }) {
  const slideAnim = useRef(new Animated.Value(-120)).current;
  const progressAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, damping: 20, stiffness: 300 }).start();
    Animated.timing(progressAnim, { toValue: 0, duration: 60000, useNativeDriver: false }).start();
    const timer = setTimeout(onDismiss, 60000);
    return () => clearTimeout(timer);
  }, []);

  const progressWidth = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  return (
    <Animated.View style={[styles.toastContainer, { transform: [{ translateY: slideAnim }] }]}>
      <TouchableOpacity
        style={[styles.card, { backgroundColor: "#7f1d1d", borderColor: "#F2050566" }]}
        onPress={onPress}
        activeOpacity={0.85}
      >
        <View style={styles.topRow}>
          <View style={styles.pulseWrap}>
            <View style={[styles.pulseDot, { backgroundColor: "#F20505" }]} />
          </View>
          <Text style={styles.toastTitle}>New Lead!</Text>
          <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="x" size={16} color="rgba(255,255,255,0.4)" />
          </TouchableOpacity>
        </View>
        <Text style={styles.toastName}>{lead.firstName} {lead.lastName}</Text>
        <View style={styles.toastMeta}>
          {lead.source && <Text style={styles.toastSource}>{lead.source}</Text>}
          {lead.phone && <Text style={styles.toastPhone}>{lead.phone}</Text>}
        </View>
        <Animated.View style={[styles.progressBar, { width: progressWidth }]} />
      </TouchableOpacity>
    </Animated.View>
  );
}

export function NewLeadToastProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { on, off } = useSocket();
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === "web";

  const [toastLead, setToastLead] = useState<ToastLead | null>(null);
  const [podiumToast, setPodiumToast] = useState<PodiumToast | null>(null);
  const recentToastIds = useRef(new Set<number>());
  const recentPodiumIds = useRef(new Set<number>());
  const pushLeadIds = useRef(new Set<number>());

  const recordPushLeadId = (leadId: number) => {
    pushLeadIds.current.add(leadId);
    setTimeout(() => pushLeadIds.current.delete(leadId), 120000);
  };

  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data;
      if (data?.leadId) {
        recordPushLeadId(Number(data.leadId));
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!user) return;

    const handleNewLead = (data: ToastLead) => {
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (
        data &&
        data.id &&
        AppState.currentState === "active" &&
        !recentToastIds.current.has(data.id) &&
        !pushLeadIds.current.has(data.id)
      ) {
        recentToastIds.current.add(data.id);
        setTimeout(() => recentToastIds.current.delete(data.id), 120000);
        setToastLead(data);
      }
    };

    const handlePodiumMessage = (data: PodiumToast) => {
      if (
        data &&
        data.id &&
        data.direction === "inbound" &&
        AppState.currentState === "active" &&
        !recentPodiumIds.current.has(data.id)
      ) {
        recentPodiumIds.current.add(data.id);
        setTimeout(() => recentPodiumIds.current.delete(data.id), 120000);
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setPodiumToast(data);
      }
    };

    on("new-lead", handleNewLead);
    on("podium-message", handlePodiumMessage);
    return () => { off("new-lead", handleNewLead); off("podium-message", handlePodiumMessage); };
  }, [user?.id, on, off]);

  return (
    <NewLeadToastContext.Provider value={{ recordPushLeadId }}>
      {children}
      {toastLead && (
        <View style={{ position: "absolute", top: isWeb ? 67 : insets.top + 8, left: 0, right: 0, zIndex: 9999 }}>
          <ToastBanner
            lead={toastLead}
            onPress={() => {
              const id = toastLead.id;
              setToastLead(null);
              router.push({ pathname: "/lead/[id]", params: { id: String(id), lead: JSON.stringify(toastLead) } });
            }}
            onDismiss={() => setToastLead(null)}
          />
        </View>
      )}
      {podiumToast && !toastLead && (
        <View style={{ position: "absolute", top: isWeb ? 67 : insets.top + 8, left: 0, right: 0, zIndex: 9998 }}>
          <PodiumToastBanner
            data={podiumToast}
            onPress={() => {
              const leadId = podiumToast.leadId;
              setPodiumToast(null);
              if (leadId) {
                router.push({ pathname: "/lead/[id]", params: { id: String(leadId) } });
              }
            }}
            onDismiss={() => setPodiumToast(null)}
          />
        </View>
      )}
    </NewLeadToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  toastContainer: { position: "absolute", top: 0, left: 16, right: 16, zIndex: 100 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, overflow: "hidden" },
  topRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  pulseWrap: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  pulseDot: { width: 10, height: 10, borderRadius: 5 },
  toastTitle: { flex: 1, fontSize: 14, fontFamily: "Inter_700Bold", color: "#F87171" },
  toastName: { fontSize: 16, fontFamily: "Inter_700Bold", color: "#FFFFFF" },
  toastMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  toastSource: { fontSize: 11, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.5)" },
  toastPhone: { fontSize: 11, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.3)" },
  progressBar: { position: "absolute", bottom: 0, left: 0, height: 2, backgroundColor: "rgba(242,5,5,0.6)" },
  podiumBadge: { backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  podiumBadgeText: { fontSize: 9, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.3)" },
  podiumBody: { fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", marginTop: 4 },
});
