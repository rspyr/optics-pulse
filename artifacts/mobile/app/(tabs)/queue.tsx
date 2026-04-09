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
  Animated,
  TextInput,
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
import { usePauseState } from "@/hooks/usePauseState";
import { LeadCard } from "@/components/LeadCard";
import { EditableSourcePicker } from "@/components/EditableSourcePicker";

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
  const { isPaused, toggling: pauseToggling, toggle: togglePause, isManagerPaused } = usePauseState();
  const isCsr = user?.role === "client_user";
  const [activeTab, setActiveTab] = useState<Tab>("new");
  const [queue, setQueue] = useState<QueueData>({ newLeads: [], callbacks: [], reengagement: [], oldLeads: [], archive: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const isWeb = Platform.OS === "web";
  const [csrDropdownOpen, setCsrDropdownOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [searchResults, setSearchResults] = useState<{ leads: QueueLead[]; total: number }>({ leads: [], total: 0 });
  const [searchLoading, setSearchLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [searchFunnelId, setSearchFunnelId] = useState<number | null>(null);
  const [searchDateType, setSearchDateType] = useState<"created" | "lastTouchpoint">("created");
  const [searchStartDate, setSearchStartDate] = useState("");
  const [searchEndDate, setSearchEndDate] = useState("");
  const [funnelTypes, setFunnelTypes] = useState<{ id: number; name: string }[]>([]);
  const [funnelDropdownOpen, setFunnelDropdownOpen] = useState(false);
  const [dateTypeDropdownOpen, setDateTypeDropdownOpen] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!effectiveTenantId) return;
    apiFetch(`/api/funnel-types?tenantId=${effectiveTenantId}`)
      .then((data: any) => { if (Array.isArray(data)) setFunnelTypes(data); })
      .catch(() => {});
  }, [effectiveTenantId, apiFetch]);

  const doSearch = useCallback(async (q: string, fId: number | null, dType: string, sDate: string, eDate: string) => {
    if (!effectiveTenantId) return;
    const hasQ = q.trim().length > 0;
    const hasDate = sDate || eDate;
    const hasFunnel = fId !== null;
    if (!hasQ && !hasDate && !hasFunnel) {
      setSearchResults({ leads: [], total: 0 });
      setSearchActive(false);
      return;
    }
    setSearchLoading(true);
    setSearchActive(true);
    try {
      const params = new URLSearchParams({ tenantId: String(effectiveTenantId) });
      if (q.trim()) params.set("q", q.trim());
      if (fId) params.set("funnelId", String(fId));
      if (sDate) params.set("startDate", new Date(sDate).toISOString());
      if (eDate) {
        const ed = new Date(eDate);
        ed.setHours(23, 59, 59, 999);
        params.set("endDate", ed.toISOString());
      }
      if (dType === "lastTouchpoint") params.set("dateType", "lastTouchpoint");
      const data = await apiFetch(`/api/leads/search?${params}`);
      setSearchResults(data);
    } catch (err) { console.error("[LeadSearch] fetch error:", err); } finally { setSearchLoading(false); }
  }, [effectiveTenantId, apiFetch]);

  const handleSearchChange = useCallback((text: string) => {
    setSearchQuery(text);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      doSearch(text, searchFunnelId, searchDateType, searchStartDate, searchEndDate);
    }, 350);
  }, [doSearch, searchFunnelId, searchDateType, searchStartDate, searchEndDate]);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchActive(false);
    setSearchResults({ leads: [], total: 0 });
    setSearchFunnelId(null);
    setSearchStartDate("");
    setSearchEndDate("");
    setShowFilters(false);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
  }, []);

  useEffect(() => {
    clearSearch();
  }, [effectiveTenantId]);

  useEffect(() => {
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, []);

  const [callbackNotification, setCallbackNotification] = useState<QueueLead | null>(null);
  const notifiedCallbackKeysRef = useRef<Set<string>>(new Set());
  const callbackBannerAnim = useRef(new Animated.Value(0)).current;

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

  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedFetchQueue = useCallback(() => {
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => { fetchQueue(); }, 500);
  }, [fetchQueue]);

  useEffect(() => {
    return () => { if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current); };
  }, []);

  useEffect(() => {
    const handleNewLead = (data: any) => {
      if (data && data.id) {
        setQueue(prev => ({
          ...prev,
          newLeads: [data as QueueLead, ...(prev.newLeads || []).filter(l => l.id !== data.id)],
          total: prev.total + 1,
        }));
      }
      debouncedFetchQueue();
    };
    const handleUpdate = () => debouncedFetchQueue();
    const handleReconnect = () => fetchQueue();
    on("new-lead", handleNewLead);
    on("lead-updated", handleUpdate);
    on("_reconnect", handleReconnect);
    return () => {
      off("new-lead", handleNewLead);
      off("lead-updated", handleUpdate);
      off("_reconnect", handleReconnect);
    };
  }, [on, off, fetchQueue, debouncedFetchQueue]);

  useEffect(() => {
    if (callbackNotification) return;
    const callbacks = queue.callbacks || [];
    const dueCallbacks = callbacks.filter(l => {
      if (!l.callbackAt) return false;
      const key = `${effectiveTenantId}:${l.id}:${l.callbackAt}`;
      if (notifiedCallbackKeysRef.current.has(key)) return false;
      return new Date(l.callbackAt).getTime() <= Date.now();
    });
    if (dueCallbacks.length > 0) {
      const lead = dueCallbacks[0];
      notifiedCallbackKeysRef.current.add(`${effectiveTenantId}:${lead.id}:${lead.callbackAt}`);
      setCallbackNotification(lead);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  }, [queue.callbacks, callbackNotification, effectiveTenantId]);

  useEffect(() => {
    if (callbackNotification) {
      Animated.spring(callbackBannerAnim, { toValue: 1, useNativeDriver: true, tension: 80, friction: 10 }).start();
    } else {
      callbackBannerAnim.setValue(0);
    }
  }, [callbackNotification, callbackBannerAnim]);

  const dismissCallbackBanner = useCallback(() => {
    Animated.timing(callbackBannerAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      setCallbackNotification(null);
    });
  }, [callbackBannerAnim]);

  const handleCallbackBannerPress = useCallback(() => {
    if (!callbackNotification) return;
    setActiveTab("callbacks");
    scrollTabIntoView("callbacks");
    router.push({ pathname: "/lead/[id]", params: { id: String(callbackNotification.id), lead: JSON.stringify(callbackNotification) } });
    dismissCallbackBanner();
  }, [callbackNotification, dismissCallbackBanner, scrollTabIntoView]);

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
        <View style={styles.headerTopRow}>
          <View style={styles.headerTitleGroup}>
            <Text style={[styles.title, { color: colors.foreground }]}>Lead Queue</Text>
            <View style={[styles.totalBadge, { backgroundColor: colors.primary + "20" }]}>
              <Text style={[styles.totalText, { color: colors.primary }]}>{queue.total} active</Text>
            </View>
          </View>
          {isCsr && (
            <TouchableOpacity
              onPress={() => { togglePause(); if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); }}
              disabled={pauseToggling || isManagerPaused}
              activeOpacity={0.7}
              style={[
                styles.pauseButton,
                {
                  backgroundColor: isPaused ? "#F59E0B20" : "#10B98120",
                  borderColor: isPaused ? "#F59E0B40" : "#10B98140",
                  opacity: pauseToggling || isManagerPaused ? 0.5 : 1,
                },
              ]}
            >
              <Feather name={isPaused ? "pause" : "play"} size={14} color={isPaused ? "#F59E0B" : "#10B981"} />
              <Text style={[styles.pauseButtonText, { color: isPaused ? "#F59E0B" : "#10B981" }]}>
                {isPaused ? "PAUSED" : "ACTIVE"}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={[styles.searchContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.searchRow}>
          <View style={[styles.searchInputWrap, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
            <Feather name="search" size={16} color={colors.mutedForeground} />
            <TextInput
              style={[styles.searchInput, { color: colors.foreground }]}
              placeholder="Search by name, phone, email..."
              placeholderTextColor={colors.mutedForeground}
              value={searchQuery}
              onChangeText={handleSearchChange}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {(searchQuery.length > 0 || searchActive) && (
              <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Feather name="x" size={16} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={[styles.filterButton, { backgroundColor: showFilters || searchFunnelId || searchStartDate || searchEndDate ? colors.primary + "20" : colors.secondary, borderColor: showFilters || searchFunnelId || searchStartDate || searchEndDate ? colors.primary : colors.border }]}
            onPress={() => setShowFilters(!showFilters)}
            activeOpacity={0.7}
          >
            <Feather name="sliders" size={16} color={showFilters || searchFunnelId || searchStartDate || searchEndDate ? colors.primary : colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        {showFilters && (
          <View style={styles.filtersArea}>
            <View style={styles.filterRow}>
              <View style={styles.filterCol}>
                <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>FUNNEL</Text>
                <TouchableOpacity
                  style={[styles.filterDropdown, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                  onPress={() => { setFunnelDropdownOpen(!funnelDropdownOpen); setDateTypeDropdownOpen(false); }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.filterDropdownText, { color: colors.foreground }]} numberOfLines={1}>
                    {searchFunnelId ? funnelTypes.find(f => f.id === searchFunnelId)?.name || "Select" : "All"}
                  </Text>
                  <Feather name="chevron-down" size={14} color={colors.mutedForeground} />
                </TouchableOpacity>
                {funnelDropdownOpen && (
                  <View style={[styles.filterDropdownList, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <TouchableOpacity
                      style={[styles.filterDropdownItem, !searchFunnelId && { backgroundColor: colors.primary + "15" }]}
                      onPress={() => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); setSearchFunnelId(null); setFunnelDropdownOpen(false); doSearch(searchQuery, null, searchDateType, searchStartDate, searchEndDate); }}
                    >
                      <Text style={[styles.filterDropdownItemText, { color: !searchFunnelId ? colors.primary : colors.foreground }]}>All Funnels</Text>
                    </TouchableOpacity>
                    {funnelTypes.map(f => (
                      <TouchableOpacity
                        key={f.id}
                        style={[styles.filterDropdownItem, searchFunnelId === f.id && { backgroundColor: colors.primary + "15" }]}
                        onPress={() => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); setSearchFunnelId(f.id); setFunnelDropdownOpen(false); doSearch(searchQuery, f.id, searchDateType, searchStartDate, searchEndDate); }}
                      >
                        <Text style={[styles.filterDropdownItemText, { color: searchFunnelId === f.id ? colors.primary : colors.foreground }]}>{f.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              <View style={styles.filterCol}>
                <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>DATE TYPE</Text>
                <TouchableOpacity
                  style={[styles.filterDropdown, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                  onPress={() => { setDateTypeDropdownOpen(!dateTypeDropdownOpen); setFunnelDropdownOpen(false); }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.filterDropdownText, { color: colors.foreground }]} numberOfLines={1}>
                    {searchDateType === "created" ? "Date Entered" : "Last Touch"}
                  </Text>
                  <Feather name="chevron-down" size={14} color={colors.mutedForeground} />
                </TouchableOpacity>
                {dateTypeDropdownOpen && (
                  <View style={[styles.filterDropdownList, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <TouchableOpacity
                      style={[styles.filterDropdownItem, searchDateType === "created" && { backgroundColor: colors.primary + "15" }]}
                      onPress={() => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); setSearchDateType("created"); setDateTypeDropdownOpen(false); doSearch(searchQuery, searchFunnelId, "created", searchStartDate, searchEndDate); }}
                    >
                      <Text style={[styles.filterDropdownItemText, { color: searchDateType === "created" ? colors.primary : colors.foreground }]}>Date Entered</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.filterDropdownItem, searchDateType === "lastTouchpoint" && { backgroundColor: colors.primary + "15" }]}
                      onPress={() => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); setSearchDateType("lastTouchpoint"); setDateTypeDropdownOpen(false); doSearch(searchQuery, searchFunnelId, "lastTouchpoint", searchStartDate, searchEndDate); }}
                    >
                      <Text style={[styles.filterDropdownItemText, { color: searchDateType === "lastTouchpoint" ? colors.primary : colors.foreground }]}>Last Touchpoint</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>

            <View style={styles.filterRow}>
              <View style={styles.filterCol}>
                <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>FROM</Text>
                <TextInput
                  style={[styles.dateInput, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.mutedForeground}
                  value={searchStartDate}
                  onChangeText={v => { setSearchStartDate(v); if (v.match(/^\d{4}-\d{2}-\d{2}$/) || v === "") doSearch(searchQuery, searchFunnelId, searchDateType, v, searchEndDate); }}
                  keyboardType="default"
                  maxLength={10}
                />
              </View>
              <View style={styles.filterCol}>
                <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>TO</Text>
                <TextInput
                  style={[styles.dateInput, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.mutedForeground}
                  value={searchEndDate}
                  onChangeText={v => { setSearchEndDate(v); if (v.match(/^\d{4}-\d{2}-\d{2}$/) || v === "") doSearch(searchQuery, searchFunnelId, searchDateType, searchStartDate, v); }}
                  keyboardType="default"
                  maxLength={10}
                />
              </View>
            </View>
          </View>
        )}
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

      {!searchActive && (
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
      )}

      {!searchActive && callbackNotification && (
        <Animated.View style={[styles.callbackBanner, { backgroundColor: "#F59E0B", transform: [{ translateY: callbackBannerAnim.interpolate({ inputRange: [0, 1], outputRange: [-60, 0] }) }], opacity: callbackBannerAnim }]}>
          <TouchableOpacity style={styles.callbackBannerContent} onPress={handleCallbackBannerPress} activeOpacity={0.8}>
            <Feather name="phone-incoming" size={16} color="#000" />
            <View style={styles.callbackBannerText}>
              <Text style={styles.callbackBannerTitle}>Callback Due</Text>
              <Text style={styles.callbackBannerName} numberOfLines={1}>
                {[callbackNotification.firstName, callbackNotification.lastName].filter(Boolean).join(" ") || "Unknown"}
                {callbackNotification.callbackAt ? ` — ${new Date(callbackNotification.callbackAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
              </Text>
            </View>
            <TouchableOpacity onPress={dismissCallbackBanner} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Feather name="x" size={18} color="#000" />
            </TouchableOpacity>
          </TouchableOpacity>
        </Animated.View>
      )}

      {searchActive ? (
        searchLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <FlatList
            data={searchResults.leads}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => (
              <LeadCard lead={item} onPress={handleLeadPress} />
            )}
            contentContainerStyle={[
              styles.listContent,
              { paddingBottom: isWeb ? 34 + 90 : insets.bottom + 90 },
            ]}
            ListHeaderComponent={
              <View style={styles.searchResultsHeader}>
                <Text style={[styles.searchResultsCount, { color: colors.mutedForeground }]}>
                  {searchResults.total} result{searchResults.total !== 1 ? "s" : ""}
                </Text>
                <TouchableOpacity onPress={clearSearch}>
                  <Text style={[styles.backToQueue, { color: colors.primary }]}>Back to queue</Text>
                </TouchableOpacity>
              </View>
            }
            ListEmptyComponent={
              <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={[styles.emptyIconWrap, { backgroundColor: "rgba(255,255,255,0.05)" }]}>
                  <Feather name="search" size={24} color={colors.mutedForeground} />
                </View>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No Results</Text>
                <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
                  No leads match your search. Try a different name, phone, or adjust filters.
                </Text>
              </View>
            }
          />
        )
      ) : loading ? (
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
              renderSourceOverride={activeTab === "archive" ? (lead) => (
                <EditableSourcePicker
                  leadId={lead.id}
                  source={lead.source || "Unknown"}
                  tenantId={effectiveTenantId}
                  onSourceChanged={(newSource) => {
                    setQueue(prev => ({
                      ...prev,
                      archive: prev.archive.map(l => l.id === lead.id ? { ...l, source: newSource } : l),
                    }));
                  }}
                  compact
                />
              ) : undefined}
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
  headerArea: { paddingHorizontal: 16, paddingBottom: 12 },
  headerTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerTitleGroup: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 22, fontFamily: "Inter_700Bold" },
  totalBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  totalText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  pauseButton: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  pauseButtonText: { fontSize: 12, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  csrSelector: { marginHorizontal: 16, marginBottom: 8, borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  csrHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  csrLabel: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  csrDropdown: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  csrValue: { fontSize: 14, fontFamily: "Inter_500Medium", flex: 1 },
  csrDropdownList: { borderRadius: 8, borderWidth: 1, overflow: "hidden" },
  csrItem: { paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  csrItemText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  csrViewingAs: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic" },
  tabScroll: { borderBottomWidth: 1, flexGrow: 0, flexShrink: 0 },
  tabScrollContent: { gap: 2, paddingHorizontal: 12 },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minHeight: 38,
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
  callbackBanner: { marginHorizontal: 16, marginTop: 8, borderRadius: 10, overflow: "hidden" },
  callbackBannerContent: { flexDirection: "row", alignItems: "center", padding: 12, gap: 10 },
  callbackBannerText: { flex: 1 },
  callbackBannerTitle: { fontSize: 13, fontFamily: "Inter_700Bold", color: "#000" },
  callbackBannerName: { fontSize: 12, fontFamily: "Inter_500Medium", color: "#000", opacity: 0.8 },
  searchContainer: { marginHorizontal: 16, marginBottom: 8, gap: 8 },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  searchInputWrap: { flex: 1, flexDirection: "row", alignItems: "center", borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, gap: 8, height: 42 },
  searchInput: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", paddingVertical: 0 },
  filterButton: { width: 42, height: 42, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  filtersArea: { gap: 8 },
  filterRow: { flexDirection: "row", gap: 8 },
  filterCol: { flex: 1, gap: 4 },
  filterLabel: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  filterDropdown: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  filterDropdownText: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1 },
  filterDropdownList: { borderRadius: 8, borderWidth: 1, overflow: "hidden", marginTop: 2 },
  filterDropdownItem: { paddingHorizontal: 12, paddingVertical: 10 },
  filterDropdownItemText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  dateInput: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, fontFamily: "Inter_400Regular" },
  searchResultsHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  searchResultsCount: { fontSize: 12, fontFamily: "Inter_500Medium" },
  backToQueue: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
});
