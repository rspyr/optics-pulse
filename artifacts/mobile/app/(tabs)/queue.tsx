import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useAuth } from "@/contexts/AuthContext";
import { useSocket } from "@/contexts/SocketContext";
import { useApi } from "@/hooks/useApi";
import { useColors } from "@/hooks/useColors";
import { LeadCard } from "@/components/LeadCard";

type Tab = "new" | "reengagement" | "callbacks" | "old";

interface QueueLead {
  id: number;
  name: string;
  phone?: string;
  email?: string;
  source?: string;
  hubStatus?: string;
  dayInSequence?: number;
  createdAt?: string;
  callbackAt?: string;
  assignedUserName?: string;
}

interface QueueData {
  newLeads: QueueLead[];
  callbacks: QueueLead[];
  reengagement: QueueLead[];
  oldLeads: QueueLead[];
  total: number;
}

const TABS: { key: Tab; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { key: "new", label: "New", icon: "zap" },
  { key: "reengagement", label: "Re-engage", icon: "refresh-cw" },
  { key: "callbacks", label: "Callbacks", icon: "phone-incoming" },
  { key: "old", label: "Old", icon: "archive" },
];

function getBadgeForTab(tab: Tab, lead: QueueLead): string | undefined {
  if (tab === "new") return "NEW";
  if (tab === "reengagement") return `Day ${lead.dayInSequence || 1}`;
  if (tab === "callbacks") return "CALLBACK";
  if (tab === "old") return "5+ DAYS";
  return undefined;
}

export default function QueueScreen() {
  const { user } = useAuth();
  const { on, off } = useSocket();
  const { apiFetch } = useApi();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<Tab>("new");
  const [queue, setQueue] = useState<QueueData>({ newLeads: [], callbacks: [], reengagement: [], oldLeads: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const isWeb = Platform.OS === "web";

  const fetchQueue = useCallback(async () => {
    if (!user) return;
    try {
      const data = await apiFetch("/api/leads-hub/queue");
      setQueue(data);
    } catch (err) {
      console.error("[Queue] Failed to fetch:", err);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, user]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  useEffect(() => {
    const handleNewLead = () => {
      fetchQueue();
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    };
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
      default: return [];
    }
  };

  const leads = getLeadsForTab();

  const tabCounts: Record<Tab, number> = {
    new: (queue.newLeads || []).length,
    reengagement: (queue.reengagement || []).length,
    callbacks: (queue.callbacks || []).length,
    old: (queue.oldLeads || []).length,
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.headerArea, { paddingTop: isWeb ? 67 + 12 : insets.top + 12 }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>Lead Queue</Text>
        <View style={[styles.totalBadge, { backgroundColor: colors.primary + "20" }]}>
          <Text style={[styles.totalText, { color: colors.primary }]}>{queue.total} active</Text>
        </View>
      </View>

      <View style={[styles.tabs, { borderBottomColor: colors.border }]}>
        {TABS.map(tab => {
          const isActive = activeTab === tab.key;
          const count = tabCounts[tab.key];
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, isActive && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
              onPress={() => {
                setActiveTab(tab.key);
                if (Platform.OS !== "web") Haptics.selectionAsync();
              }}
              activeOpacity={0.7}
            >
              <Feather name={tab.icon} size={14} color={isActive ? colors.primary : colors.mutedForeground} />
              <Text style={[styles.tabLabel, { color: isActive ? colors.primary : colors.mutedForeground }]}>
                {tab.label}
              </Text>
              {count > 0 && (
                <View style={[styles.countBadge, { backgroundColor: isActive ? colors.primary : colors.secondary }]}>
                  <Text style={[styles.countText, { color: isActive ? colors.primaryForeground : colors.mutedForeground }]}>
                    {count}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

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
              showBadge={getBadgeForTab(activeTab, item)}
            />
          )}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: isWeb ? 34 + 90 : insets.bottom + 90 },
          ]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          scrollEnabled={leads.length > 0}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Feather name="inbox" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No leads here</Text>
              <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
                {activeTab === "new" ? "New leads will appear when assigned to you" :
                 activeTab === "callbacks" ? "No scheduled callbacks due right now" :
                 activeTab === "reengagement" ? "No leads to re-engage at this time" :
                 "No old leads in queue"}
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
  tabs: { flexDirection: "row", paddingHorizontal: 8, borderBottomWidth: 1 },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 10,
    paddingBottom: 12,
  },
  tabLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  countBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6, minWidth: 18, alignItems: "center" },
  countText: { fontSize: 10, fontFamily: "Inter_700Bold" },
  listContent: { paddingHorizontal: 16, paddingTop: 12 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyState: { alignItems: "center", justifyContent: "center", paddingTop: 80, gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  emptySubtitle: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", paddingHorizontal: 40 },
});
