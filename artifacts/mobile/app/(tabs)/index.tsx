import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  Platform,
  TouchableOpacity,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useAuth } from "@/contexts/AuthContext";
import { useSocket } from "@/contexts/SocketContext";
import { useApi } from "@/hooks/useApi";
import { useColors } from "@/hooks/useColors";
import { StatCard } from "@/components/StatCard";

interface HudStats {
  callsMadeToday: number;
  bookingsToday: number;
  bookingRate: number;
  commission: number;
  newLeadsToday: number;
  avgSpeedToLead: number;
  bonusTier: string;
}

function formatSpeed(seconds: number): string {
  if (seconds <= 0) return "--";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function getTierColor(tier: string, colors: ReturnType<typeof useColors>): string {
  if (tier === "gold") return "#FFD700";
  if (tier === "silver") return "#C0C0C0";
  if (tier === "bronze") return "#CD7F32";
  return colors.mutedForeground;
}

export default function HudScreen() {
  const { user, logout } = useAuth();
  const { connected, on, off } = useSocket();
  const { apiFetch } = useApi();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [stats, setStats] = useState<HudStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const isWeb = Platform.OS === "web";

  const fetchStats = useCallback(async () => {
    if (!user) return;
    try {
      const data = await apiFetch("/api/leads/hud/stats");
      setStats(data);
    } catch (err) {
      console.error("[HUD] Failed to fetch stats:", err);
    }
  }, [apiFetch, user]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  useEffect(() => {
    const handler = () => {
      fetchStats();
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    };
    const statsHandler = (data: HudStats) => {
      setStats(data);
    };
    on("lead-updated", handler);
    on("new-lead", handler);
    on("hud-stats", statsHandler);
    return () => {
      off("lead-updated", handler);
      off("new-lead", handler);
      off("hud-stats", statsHandler);
    };
  }, [on, off, fetchStats]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchStats();
    setRefreshing(false);
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: isWeb ? 67 + 16 : insets.top + 16,
          paddingBottom: isWeb ? 34 + 90 : insets.bottom + 90,
        },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <View style={styles.header}>
        <View>
          <Text style={[styles.greeting, { color: colors.mutedForeground }]}>Welcome back</Text>
          <Text style={[styles.userName, { color: colors.foreground }]}>{user?.name || "Agent"}</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={styles.liveIndicator}>
            <View style={[styles.liveDot, { backgroundColor: connected ? colors.emerald : colors.red }]} />
            <Text style={[styles.liveText, { color: connected ? colors.emerald : colors.red }]}>
              {connected ? "LIVE" : "OFFLINE"}
            </Text>
          </View>
          <TouchableOpacity onPress={logout} style={[styles.logoutBtn, { backgroundColor: colors.card }]}>
            <Feather name="log-out" size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      </View>

      {stats?.bonusTier && stats.bonusTier !== "none" && (
        <View style={[styles.tierBanner, { backgroundColor: getTierColor(stats.bonusTier, colors) + "15", borderColor: getTierColor(stats.bonusTier, colors) + "30" }]}>
          <Feather name="award" size={18} color={getTierColor(stats.bonusTier, colors)} />
          <Text style={[styles.tierText, { color: getTierColor(stats.bonusTier, colors) }]}>
            {stats.bonusTier.charAt(0).toUpperCase() + stats.bonusTier.slice(1)} Tier — {stats.bookingRate}% booking rate
          </Text>
        </View>
      )}

      <View style={styles.statsGrid}>
        <View style={styles.statsRow}>
          <StatCard
            icon="phone-call"
            label="Calls"
            value={stats?.callsMadeToday ?? 0}
            color={colors.primary}
          />
          <StatCard
            icon="calendar"
            label="Booked"
            value={stats?.bookingsToday ?? 0}
            color={colors.emerald}
          />
        </View>
        <View style={styles.statsRow}>
          <StatCard
            icon="trending-up"
            label="Book Rate"
            value={`${stats?.bookingRate ?? 0}%`}
            color={colors.amber}
          />
          <StatCard
            icon="dollar-sign"
            label="Earned"
            value={`$${stats?.commission ?? 0}`}
            color={colors.emerald}
            subtitle="Commission"
          />
        </View>
        <View style={styles.statsRow}>
          <StatCard
            icon="zap"
            label="Speed to Lead"
            value={formatSpeed(stats?.avgSpeedToLead ?? 0)}
            color={colors.cyan}
          />
          <StatCard
            icon="inbox"
            label="New Leads"
            value={stats?.newLeadsToday ?? 0}
            color={colors.purple}
          />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 16, gap: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  greeting: { fontSize: 13, fontFamily: "Inter_400Regular" },
  userName: { fontSize: 22, fontFamily: "Inter_700Bold" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  liveIndicator: { flexDirection: "row", alignItems: "center", gap: 5 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  logoutBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  tierBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  tierText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  statsGrid: { gap: 10 },
  statsRow: { flexDirection: "row", gap: 10 },
});
