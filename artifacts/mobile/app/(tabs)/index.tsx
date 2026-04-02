import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  Platform,
  TouchableOpacity,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useAuth } from "@/contexts/AuthContext";
import { useSocket } from "@/contexts/SocketContext";
import { useTenant } from "@/contexts/TenantContext";
import { useApi } from "@/hooks/useApi";
import { useColors } from "@/hooks/useColors";
import { useCsrFilter } from "@/contexts/CsrFilterContext";
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

type HudTimeframe = "today" | "7d" | "30d" | "90d";

const TIMEFRAME_LABELS: Record<HudTimeframe, string> = {
  today: "Today",
  "7d": "7D",
  "30d": "30D",
  "90d": "90D",
};

function getTimeframeDates(tf: HudTimeframe): { startDate: string; endDate: string } | null {
  if (tf === "today") return null;
  const now = new Date();
  const end = now.toISOString();
  const start = new Date();
  if (tf === "7d") start.setDate(start.getDate() - 7);
  else if (tf === "30d") start.setDate(start.getDate() - 30);
  else if (tf === "90d") start.setDate(start.getDate() - 90);
  start.setHours(0, 0, 0, 0);
  return { startDate: start.toISOString(), endDate: end };
}

function getTimeframeLabel(tf: HudTimeframe): string {
  if (tf === "today") return "today";
  if (tf === "7d") return "past 7 days";
  if (tf === "30d") return "past 30 days";
  return "past 90 days";
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

function getTierColor(tier: string): string {
  if (tier === "gold") return "#FFD700";
  if (tier === "silver") return "#C0C0C0";
  if (tier === "bronze") return "#CD7F32";
  return "#8B919E";
}

export default function HudScreen() {
  const { user, logout } = useAuth();
  const { connected, on, off } = useSocket();
  const { tenants, selectedTenantId, setSelectedTenantId, effectiveTenantId, isAgency } = useTenant();
  const { csrList, selectedCsrId, setSelectedCsrId, isManager } = useCsrFilter();
  const { apiFetch } = useApi();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [stats, setStats] = useState<HudStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [timeframe, setTimeframe] = useState<HudTimeframe>("today");
  const [tenantOpen, setTenantOpen] = useState(false);
  const isWeb = Platform.OS === "web";
  const [csrDropdownOpen, setCsrDropdownOpen] = useState(false);

  const fetchStats = useCallback(async () => {
    if (!user) return;
    try {
      const params = new URLSearchParams();
      const dates = getTimeframeDates(timeframe);
      if (dates) {
        params.set("startDate", dates.startDate);
        params.set("endDate", dates.endDate);
      }
      if (effectiveTenantId) {
        params.set("tenantId", String(effectiveTenantId));
      }
      if (selectedCsrId) {
        params.set("csrId", String(selectedCsrId));
      }
      const qs = params.toString();
      const url = `/api/leads/hud/stats${qs ? `?${qs}` : ""}`;
      const data = await apiFetch(url);
      setStats(data);
    } catch (err) {
      console.error("[HUD] Failed to fetch stats:", err);
    }
  }, [apiFetch, user, timeframe, effectiveTenantId, selectedCsrId]);

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

  const handleTimeframeChange = (tf: HudTimeframe) => {
    setTimeframe(tf);
    if (Platform.OS !== "web") Haptics.selectionAsync();
  };

  const tfLabel = getTimeframeLabel(timeframe);

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
        <View style={styles.headerLeft}>
          <Image
            source={require("@/assets/pulse-logo.png")}
            style={styles.headerLogo}
            resizeMode="contain"
          />
          <View>
            <Text style={[styles.greeting, { color: colors.mutedForeground }]}>Welcome back</Text>
            <Text style={[styles.userName, { color: colors.foreground }]}>{user?.name || "Agent"}</Text>
          </View>
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

      {isAgency && tenants.length > 0 && (
        <View style={[styles.tenantSelector, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.tenantHeader}>
            <Feather name="briefcase" size={14} color={colors.mutedForeground} />
            <Text style={[styles.tenantLabel, { color: colors.mutedForeground }]}>TENANT</Text>
          </View>
          <TouchableOpacity
            style={[styles.tenantDropdown, { backgroundColor: colors.secondary, borderColor: colors.border }]}
            onPress={() => setTenantOpen(!tenantOpen)}
            activeOpacity={0.7}
          >
            <Text style={[styles.tenantValue, { color: colors.foreground }]} numberOfLines={1}>
              {tenants.find(t => t.id === selectedTenantId)?.name || "Select tenant"}
            </Text>
            <Feather name={tenantOpen ? "chevron-up" : "chevron-down"} size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
          {tenantOpen && (
            <View style={[styles.tenantList, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {tenants.map(t => (
                <TouchableOpacity
                  key={t.id}
                  style={[
                    styles.tenantItem,
                    t.id === selectedTenantId && { backgroundColor: colors.primary + "15" },
                  ]}
                  onPress={() => {
                    setSelectedTenantId(t.id);
                    setTenantOpen(false);
                    if (Platform.OS !== "web") Haptics.selectionAsync();
                  }}
                >
                  <Text style={[styles.tenantItemText, {
                    color: t.id === selectedTenantId ? colors.primary : colors.foreground,
                  }]}>
                    {t.name}
                  </Text>
                  {t.id === selectedTenantId && (
                    <Feather name="check" size={14} color={colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}

      {isManager && csrList.length > 0 && (
        <View style={[styles.csrSelector, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.csrHeader}>
            <Feather name="users" size={14} color={colors.mutedForeground} />
            <Text style={[styles.csrLabel, { color: colors.mutedForeground }]}>CSR VIEW</Text>
          </View>
          <TouchableOpacity
            style={[styles.csrDropdown, { backgroundColor: colors.secondary, borderColor: colors.border }]}
            onPress={() => setCsrDropdownOpen(!csrDropdownOpen)}
            activeOpacity={0.7}
          >
            <Text style={[styles.csrValue, { color: colors.foreground }]} numberOfLines={1}>
              {selectedCsrId ? csrList.find(c => c.id === selectedCsrId)?.name || "Select CSR" : "All CSRs"}
            </Text>
            <Feather name={csrDropdownOpen ? "chevron-up" : "chevron-down"} size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
          {csrDropdownOpen && (
            <View style={[styles.csrDropdownList, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <TouchableOpacity
                style={[styles.csrItem, !selectedCsrId && { backgroundColor: colors.primary + "15" }]}
                onPress={() => { setSelectedCsrId(null); setCsrDropdownOpen(false); }}
              >
                <Text style={[styles.csrItemText, { color: !selectedCsrId ? colors.primary : colors.foreground }]}>All CSRs</Text>
                {!selectedCsrId && <Feather name="check" size={14} color={colors.primary} />}
              </TouchableOpacity>
              {csrList.map(c => (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.csrItem, selectedCsrId === c.id && { backgroundColor: colors.primary + "15" }]}
                  onPress={() => { setSelectedCsrId(c.id); setCsrDropdownOpen(false); if (Platform.OS !== "web") Haptics.selectionAsync(); }}
                >
                  <Text style={[styles.csrItemText, { color: selectedCsrId === c.id ? colors.primary : colors.foreground }]}>{c.name}</Text>
                  {selectedCsrId === c.id && <Feather name="check" size={14} color={colors.primary} />}
                </TouchableOpacity>
              ))}
            </View>
          )}
          {selectedCsrId && (
            <Text style={[styles.csrViewingAs, { color: colors.primary }]}>
              Viewing as {csrList.find(c => c.id === selectedCsrId)?.name}
            </Text>
          )}
        </View>
      )}

      <View style={[styles.timeframeRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {(["today", "7d", "30d", "90d"] as HudTimeframe[]).map(tf => (
          <TouchableOpacity
            key={tf}
            style={[
              styles.timeframeBtn,
              timeframe === tf && { backgroundColor: "rgba(255,255,255,0.1)" },
            ]}
            onPress={() => handleTimeframeChange(tf)}
            activeOpacity={0.7}
          >
            <Text style={[
              styles.timeframeText,
              { color: timeframe === tf ? "#FFFFFF" : "rgba(255,255,255,0.4)" },
            ]}>
              {TIMEFRAME_LABELS[tf]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {stats?.bonusTier && stats.bonusTier !== "none" && (
        <View style={[styles.tierBanner, { backgroundColor: getTierColor(stats.bonusTier) + "15", borderColor: getTierColor(stats.bonusTier) + "30" }]}>
          <Feather name="award" size={18} color={getTierColor(stats.bonusTier)} />
          <Text style={[styles.tierText, { color: getTierColor(stats.bonusTier) }]}>
            {stats.bonusTier.charAt(0).toUpperCase() + stats.bonusTier.slice(1)} Tier — {stats.bookingRate}% booking rate
          </Text>
        </View>
      )}

      <View style={styles.statsGrid}>
        <View style={styles.statsRow}>
          <StatCard
            icon="phone-call"
            label={`Calls ${tfLabel}`}
            value={stats?.callsMadeToday ?? 0}
            color={colors.primary}
          />
          <StatCard
            icon="calendar"
            label={`Booked ${tfLabel}`}
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
            label={`New Leads ${tfLabel}`}
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
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerLogo: { width: 36, height: 36, borderRadius: 8 },
  greeting: { fontSize: 13, fontFamily: "Inter_400Regular" },
  userName: { fontSize: 22, fontFamily: "Inter_700Bold" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  liveIndicator: { flexDirection: "row", alignItems: "center", gap: 5 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  logoutBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  timeframeRow: {
    flexDirection: "row",
    borderRadius: 10,
    borderWidth: 1,
    padding: 3,
    gap: 2,
  },
  timeframeBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 7,
    alignItems: "center",
  },
  timeframeText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
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
  tenantSelector: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  tenantHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  tenantLabel: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  tenantDropdown: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  tenantValue: { fontSize: 14, fontFamily: "Inter_500Medium", flex: 1 },
  tenantList: { borderRadius: 8, borderWidth: 1, overflow: "hidden" },
  tenantItem: { paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  tenantItemText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  csrSelector: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  csrHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  csrLabel: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  csrDropdown: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  csrValue: { fontSize: 14, fontFamily: "Inter_500Medium", flex: 1 },
  csrDropdownList: { borderRadius: 8, borderWidth: 1, overflow: "hidden" },
  csrItem: { paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  csrItemText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  csrViewingAs: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic" },
});
