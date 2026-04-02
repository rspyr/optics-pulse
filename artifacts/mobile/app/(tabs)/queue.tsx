import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Platform,
  ActivityIndicator,
  ScrollView,
  type LayoutChangeEvent,
  Dimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useAuth } from "@/contexts/AuthContext";
import { useSocket } from "@/contexts/SocketContext";
import { useTenant } from "@/contexts/TenantContext";
import { useApi } from "@/hooks/useApi";
import { useColors } from "@/hooks/useColors";
import { useCsrFilter } from "@/contexts/CsrFilterContext";
import { LeadCard } from "@/components/LeadCard";

type Tab = "new" | "reengagement" | "callbacks" | "old" | "archive";

interface QueueLead {
  id: number;
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  source?: string | null;
  leadType?: string | null;
  interestType?: string | null;
  hubStatus?: string | null;
  dayInSequence?: number;
  createdAt: string;
  callbackAt?: string | null;
  nextPassAt?: string | null;
  passIntervalMinutes?: number | null;
  attemptCount?: number;
  assignedUserName?: string;
  contactPreferences?: string[];
}

interface QueueData {
  newLeads: QueueLead[];
  callbacks: QueueLead[];
  reengagement: QueueLead[];
  oldLeads: QueueLead[];
  archive: QueueLead[];
  total: number;
}

const TABS: { key: Tab; label: string; icon: keyof typeof Feather.glyphMap; color: string }[] = [
  { key: "new", label: "New", icon: "zap", color: "#EF4444" },
  { key: "reengagement", label: "Re-engage", icon: "refresh-cw", color: "#8B5CF6" },
  { key: "callbacks", label: "Callbacks", icon: "phone-incoming", color: "#F59E0B" },
  { key: "old", label: "Old", icon: "clock", color: "#8B919E" },
  { key: "archive", label: "Archive", icon: "archive", color: "#6B7280" },
];

const EMPTY_MESSAGES: Record<Tab, string> = {
  new: "No new untouched leads right now.",
  reengagement: "No leads needing follow-up right now.",
  callbacks: "No pending callbacks.",
  old: "No old leads in queue.",
  archive: "No archived leads.",
};


export default function QueueScreen() {
  const { user } = useAuth();
  const { on, off } = useSocket();
  const { effectiveTenantId } = useTenant();
  const { csrList, selectedCsrId, setSelectedCsrId, isManager } = useCsrFilter();
  const { apiFetch } = useApi();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<Tab>("new");
  const [queue, setQueue] = useState<QueueData>({ newLeads: [], callbacks: [], reengagement: [], oldLeads: [], archive: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const isWeb = Platform.OS === "web";
  const [csrDropdownOpen, setCsrDropdownOpen] = useState(false);

  const tabScrollRef = useRef<ScrollView>(null);
  const tabLayouts = useRef<Record<string, { x: number; width: number }>>({});
  const scrollViewWidth = useRef(Dimensions.get("window").width);

  const handleTabLayout = useCallback((key: string, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    tabLayouts.current[key] = { x, width };
  }, []);

  const handleScrollViewLayout = useCallback((event: LayoutChangeEvent) => {
    scrollViewWidth.current = event.nativeEvent.layout.width;
  }, []);

  const scrollTabIntoView = useCallback((tabKey: string) => {
    const layout = tabLayouts.current[tabKey];
    if (!layout || !tabScrollRef.current) return;

    const viewWidth = scrollViewWidth.current;
    const tabCenter = layout.x + layout.width / 2;
    const scrollTarget = tabCenter - viewWidth / 2;
    const clampedTarget = Math.max(0, scrollTarget);

    tabScrollRef.current.scrollTo({ x: clampedTarget, animated: true });
  }, []);

  const fetchQueue = useCallback(async () => {
    if (!user) return;
    try {
      const params = new URLSearchParams();
      if (effectiveTenantId) params.set("tenantId", String(effectiveTenantId));
      if (selectedCsrId) params.set("csrId", String(selectedCsrId));
      const qs = params.toString();
      const tenantParam = qs ? `?${qs}` : "";
      const archiveQs = effectiveTenantId ? `tenantId=${effectiveTenantId}` : "";
      const archiveParam = archiveQs ? `?limit=50&${archiveQs}` : "?limit=50";
      if (selectedCsrId) {
        const csrArchiveParam = archiveParam + `&csrId=${selectedCsrId}`;
        const [queueData, archiveData] = await Promise.all([
          apiFetch(`/api/leads-hub/queue${tenantParam}`),
          apiFetch(`/api/leads-hub/archive${csrArchiveParam}`),
        ]);
        setQueue({ ...queueData, archive: archiveData.leads || [] });
      } else {
        const [queueData, archiveData] = await Promise.all([
          apiFetch(`/api/leads-hub/queue${tenantParam}`),
          apiFetch(`/api/leads-hub/archive${archiveParam}`),
        ]);
        setQueue({ ...queueData, archive: archiveData.leads || [] });
      }
    } catch (err) {
      console.error("[Queue] Failed to fetch:", err);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, user, effectiveTenantId, selectedCsrId]);

  useEffect(() => {
    setLoading(true);
    fetchQueue();
  }, [fetchQueue]);

  useEffect(() => {
    const handleNewLead = () => { fetchQueue(); };
    const handleUpdate = () => fetchQueue();
    on("new-lead", handleNewLead);
    on("lead-updated", handleUpdate);
    return () => {
      off("new-lead", handleNewLead);
      off("lead-updated", handleUpdate);
    };
  }, [on, off, fetchQueue]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchQueue();
    setRefreshing(false);
  };

  const handleLeadPress = (lead: QueueLead) => {
    router.push({ pathname: "/lead/[id]", params: { id: String(lead.id), lead: JSON.stringify(lead) } });
  };

  const getLeadsForTab = (): QueueLead[] => {
    switch (activeTab) {
      case "new": return queue.newLeads || [];
      case "reengagement": return queue.reengagement || [];
      case "callbacks": return queue.callbacks || [];
      case "old": return queue.oldLeads || [];
      case "archive": return queue.archive || [];
      default: return [];
    }
  };

  const leads = getLeadsForTab();

  const tabCounts: Record<Tab, number> = {
    new: (queue.newLeads || []).length,
    reengagement: (queue.reengagement || []).length,
    callbacks: (queue.callbacks || []).length,
    old: (queue.oldLeads || []).length,
    archive: (queue.archive || []).length,
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.headerArea, { paddingTop: isWeb ? 67 + 12 : insets.top + 12 }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>Lead Queue</Text>
        <View style={[styles.totalBadge, { backgroundColor: colors.primary + "20" }]}>
          <Text style={[styles.totalText, { color: colors.primary }]}>{queue.total} active</Text>
        </View>
      </View>

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

      <ScrollView
        ref={tabScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.tabScroll, { borderBottomColor: colors.border }]}
        contentContainerStyle={styles.tabScrollContent}
        onLayout={handleScrollViewLayout}
      >
        {TABS.map(tab => {
          const isActive = activeTab === tab.key;
          const count = tabCounts[tab.key];
          const tabColor = isActive ? tab.color : colors.mutedForeground;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, isActive && { borderBottomColor: tab.color, borderBottomWidth: 2 }]}
              onLayout={(e) => handleTabLayout(tab.key, e)}
              onPress={() => {
                setActiveTab(tab.key);
                scrollTabIntoView(tab.key);
                if (Platform.OS !== "web") Haptics.selectionAsync();
              }}
              activeOpacity={0.7}
            >
              <Feather name={tab.icon} size={13} color={tabColor} />
              <Text style={[styles.tabLabel, { color: tabColor }]}>
                {tab.label}
              </Text>
              {count > 0 && (
                <View style={[styles.countBadge, { backgroundColor: isActive ? tab.color + "30" : colors.secondary }]}>
                  <Text style={[styles.countText, { color: isActive ? tab.color : colors.mutedForeground }]}>
                    {count}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={leads}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <LeadCard
              lead={item}
              onPress={handleLeadPress}
            />
          )}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: isWeb ? 34 + 90 : insets.bottom + 90 },
          ]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          scrollEnabled={leads.length > 0}
          ListEmptyComponent={
            <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.emptyIconWrap, { backgroundColor: "rgba(255,255,255,0.05)" }]}>
                <Feather name="check" size={24} color="#10B981" />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                {activeTab === "archive" ? "No Archived Leads" : "Queue Clear"}
              </Text>
              <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
                {EMPTY_MESSAGES[activeTab]}
              </Text>
            </View>
          }
        />
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerArea: { paddingHorizontal: 16, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 22, fontFamily: "Inter_700Bold" },
  totalBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  totalText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  csrSelector: { marginHorizontal: 16, marginBottom: 8, borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  csrHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  csrLabel: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  csrDropdown: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  csrValue: { fontSize: 14, fontFamily: "Inter_500Medium", flex: 1 },
  csrDropdownList: { borderRadius: 8, borderWidth: 1, overflow: "hidden" },
  csrItem: { paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  csrItemText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  csrViewingAs: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic" },
  tabScroll: { borderBottomWidth: 1, maxHeight: 44 },
  tabScrollContent: { paddingHorizontal: 8, gap: 2 },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 10,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  tabLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  countBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6, minWidth: 18, alignItems: "center" },
  countText: { fontSize: 10, fontFamily: "Inter_700Bold" },
  listContent: { paddingHorizontal: 16, paddingTop: 12 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyCard: {
    marginTop: 40,
    paddingVertical: 48,
    paddingHorizontal: 24,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    gap: 12,
  },
  emptyIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_700Bold" },
  emptySubtitle: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", paddingHorizontal: 20 },
});
