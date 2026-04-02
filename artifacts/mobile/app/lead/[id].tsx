import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Linking,
  Platform,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
} from "react-native";
import { useLocalSearchParams, router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useApi } from "@/hooks/useApi";
import { useColors } from "@/hooks/useColors";
import { useSocket } from "@/contexts/SocketContext";
import { useTenant } from "@/contexts/TenantContext";

type ActionType = "call" | "text" | "voicemail_drop";
type DetailTab = "actions" | "details" | "messages" | "history";

const CALL_RESULTS = [
  { key: "no_answer", label: "No Answer", icon: "phone-missed" as const },
  { key: "left_voicemail", label: "Left VM", icon: "voicemail" as const },
  { key: "spoke_with_customer", label: "Spoke", icon: "check-circle" as const },
  { key: "bad_number", label: "Bad #", icon: "x-circle" as const },
  { key: "hung_up", label: "Hung Up", icon: "phone-off" as const },
];

const TEXT_RESULTS = [
  { key: "yes", label: "Replied", icon: "message-circle" as const },
  { key: "reached_out", label: "Sent", icon: "send" as const },
  { key: "not_able_to", label: "Unable", icon: "x-circle" as const },
];

const DEAD_REASONS = [
  { key: "not_interested", label: "Not Interested" },
  { key: "bad_contact", label: "Bad Contact Info" },
  { key: "do_not_call", label: "Do Not Call" },
  { key: "duplicate", label: "Duplicate" },
  { key: "other", label: "Other" },
];

const DAY_BADGE_CONFIG: Record<string, { label: string; color: string }> = {
  day_1: { label: "D1", color: "#10B981" },
  day_2: { label: "D2", color: "#3B82F6" },
  day_3: { label: "D3", color: "#F59E0B" },
  day_4: { label: "D4", color: "#F97316" },
  day_5_old: { label: "OLD", color: "#EF4444" },
  appt_set: { label: "APPT", color: "#10B981" },
  appt_booked: { label: "BOOKED", color: "#8B5CF6" },
  call_back: { label: "CB", color: "#F59E0B" },
  dead: { label: "DEAD", color: "#EF4444" },
};

const CONTACT_FLAGS: Record<string, { label: string; icon: keyof typeof Feather.glyphMap; color: string }> = {
  text_only: { label: "Text Only", icon: "message-square", color: "#3B82F6" },
  spanish_speaking: { label: "Spanish", icon: "globe", color: "#8B5CF6" },
  do_not_call: { label: "DNC", icon: "phone-off", color: "#EF4444" },
};

interface LeadDetail {
  id: number;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  source?: string;
  leadType?: string;
  interestType?: string;
  hubStatus?: string;
  dayInSequence?: number;
  createdAt?: string;
  notes?: string;
  assignedUserName?: string;
  address?: string;
  city?: string;
  state?: string;
  attemptCount?: number;
  callbackAt?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  addOns?: string;
  contactPreferences?: string[];
}

interface HistoryItem {
  id: number;
  actionType: string;
  outcome: string;
  notes: string | null;
  attemptedAt: string;
  userName?: string;
}

interface PodiumMessage {
  id: number;
  body: string;
  direction: string;
  channelType?: string;
  createdAt: string;
  senderName?: string;
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === "1") return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return phone;
}

export default function LeadDetailScreen() {
  const params = useLocalSearchParams<{ id: string; lead?: string }>();
  const { apiFetch } = useApi();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { on, off } = useSocket();
  const { effectiveTenantId } = useTenant();
  const isWeb = Platform.OS === "web";
  const tenantQs = effectiveTenantId ? `?tenantId=${effectiveTenantId}` : "";

  const [lead, setLead] = useState<LeadDetail | null>(() => {
    if (params.lead) {
      try { return JSON.parse(params.lead); } catch { return null; }
    }
    return null;
  });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [messages, setMessages] = useState<PodiumMessage[]>([]);
  const [actionType, setActionType] = useState<ActionType>("call");
  const [submitting, setSubmitting] = useState(false);
  const [notes, setNotes] = useState("");
  const [showDeadMenu, setShowDeadMenu] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("actions");
  const [callbackDate, setCallbackDate] = useState("");
  const [newMessage, setNewMessage] = useState("");
  const [sendingMsg, setSendingMsg] = useState(false);

  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchLead = useCallback(async () => {
    try {
      setFetchError(null);
      const data = await apiFetch(`/api/leads/${params.id}${tenantQs}`);
      setLead(data);
    } catch (err) {
      console.error("[LeadDetail] Failed to fetch lead:", err);
      setFetchError(err instanceof Error ? err.message : "Failed to load lead");
    }
  }, [apiFetch, params.id, tenantQs]);

  const fetchHistory = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/leads-hub/${params.id}/history${tenantQs}`);
      setHistory(data.attempts || []);
    } catch (err) {
      console.error("[LeadDetail] Failed to fetch history:", err);
    }
  }, [apiFetch, params.id, tenantQs]);

  const fetchMessages = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/podium/conversations/${params.id}${tenantQs}`);
      setMessages(data.messages || []);
    } catch {
    }
  }, [apiFetch, params.id, tenantQs]);

  useEffect(() => {
    if (!lead) fetchLead();
    fetchHistory();
    fetchMessages();
  }, []);

  useEffect(() => {
    const handler = (data: any) => {
      if (data?.leadId === Number(params.id)) {
        fetchMessages();
      }
    };
    on("podium-message", handler);
    return () => off("podium-message", handler);
  }, [on, off, params.id, fetchMessages]);

  const submitAction = async (result: string) => {
    if (submitting) return;
    setSubmitting(true);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const body: Record<string, unknown> = { leadId: Number(params.id), actionType, notes: notes || undefined };
      if (actionType === "call") body.callResult = result;
      else if (actionType === "text") body.textResult = result;
      else body.vmResult = "yes";

      if (result === "spoke_with_customer") {
        Alert.alert("Book Appointment?", "Did the customer book an appointment?", [
          { text: "No", onPress: async () => {
            await apiFetch("/api/leads-hub/action", { method: "POST", body: JSON.stringify(body) });
            if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            fetchLead();
            fetchHistory();
            setNotes("");
          }},
          { text: "Yes", onPress: async () => {
            body.appointmentSet = true;
            await apiFetch("/api/leads-hub/action", { method: "POST", body: JSON.stringify(body) });
            if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            fetchLead();
            fetchHistory();
            setNotes("");
          }},
        ]);
        setSubmitting(false);
        return;
      }

      await apiFetch("/api/leads-hub/action", { method: "POST", body: JSON.stringify(body) });
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      fetchLead();
      fetchHistory();
      setNotes("");
    } catch (err) {
      Alert.alert("Error", "Failed to log action");
    } finally {
      setSubmitting(false);
    }
  };

  const scheduleCallback = async () => {
    if (!callbackDate) {
      Alert.alert("Error", "Please enter a callback date/time");
      return;
    }
    const parsed = new Date(callbackDate);
    if (isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      Alert.alert("Error", "Please enter a valid future date and time (e.g. 2026-04-03 14:30)");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/api/leads-hub/action", {
        method: "POST",
        body: JSON.stringify({
          leadId: Number(params.id),
          actionType: "call",
          callResult: "no_answer",
          callbackAt: parsed.toISOString(),
          notes: "Callback scheduled from mobile",
        }),
      });
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCallbackDate("");
      fetchLead();
      fetchHistory();
      Alert.alert("Success", "Callback scheduled");
    } catch {
      Alert.alert("Error", "Failed to schedule callback");
    } finally {
      setSubmitting(false);
    }
  };

  const markDead = async (reason: string) => {
    setSubmitting(true);
    try {
      await apiFetch("/api/leads-hub/action", {
        method: "POST",
        body: JSON.stringify({ leadId: Number(params.id), actionType: "call", callResult: "no_answer", deadReason: reason }),
      });
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      fetchLead();
      setShowDeadMenu(false);
    } catch {
      Alert.alert("Error", "Failed to update lead");
    } finally {
      setSubmitting(false);
    }
  };

  const sendPodiumMessage = async () => {
    if (!newMessage.trim() || sendingMsg) return;
    setSendingMsg(true);
    try {
      await apiFetch("/api/podium/messages", {
        method: "POST",
        body: JSON.stringify({ leadId: Number(params.id), message: newMessage.trim() }),
      });
      setNewMessage("");
      fetchMessages();
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert("Error", "Failed to send message. Make sure Podium is connected.");
    } finally {
      setSendingMsg(false);
    }
  };

  const dialPhone = () => {
    if (lead?.phone) Linking.openURL(`tel:${lead.phone.replace(/\D/g, "")}`);
  };

  const sendSMS = () => {
    if (lead?.phone) Linking.openURL(`sms:${lead.phone.replace(/\D/g, "")}`);
  };

  if (!lead) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        {fetchError ? (
          <>
            <Feather name="alert-circle" size={48} color={colors.red} />
            <Text style={{ color: colors.foreground, marginTop: 12, fontSize: 16 }}>{fetchError}</Text>
            <TouchableOpacity onPress={fetchLead} style={{ marginTop: 16, padding: 12, backgroundColor: colors.primary, borderRadius: 8 }}>
              <Text style={{ color: "#fff", fontWeight: "600" }}>Retry</Text>
            </TouchableOpacity>
          </>
        ) : (
          <ActivityIndicator size="large" color={colors.primary} />
        )}
      </View>
    );
  }

  const dayBadge = DAY_BADGE_CONFIG[lead.hubStatus || ""] || null;
  const statusColor = dayBadge?.color || colors.primary;
  const results = actionType === "call" ? CALL_RESULTS : actionType === "text" ? TEXT_RESULTS : [];
  const isTerminal = lead.hubStatus === "appt_set" || lead.hubStatus === "dead";
  const contactPrefs = lead.contactPreferences || [];

  const DETAIL_TABS: { key: DetailTab; label: string; icon: keyof typeof Feather.glyphMap; badge?: number }[] = [
    { key: "actions", label: "Actions", icon: "zap" },
    { key: "details", label: "Details", icon: "file-text" },
    { key: "messages", label: "Messages", icon: "message-circle", badge: messages.length },
    { key: "history", label: "History", icon: "clock", badge: history.length },
  ];

  return (
    <>
      <Stack.Screen options={{
        title: `${lead.firstName} ${lead.lastName}`,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
      }} />
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: colors.background }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={100}
      >
        <ScrollView
          style={[styles.container, { backgroundColor: colors.background }]}
          contentContainerStyle={{ paddingBottom: isWeb ? 34 + 20 : insets.bottom + 20 }}
        >
          <View style={[styles.contactCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.contactHeader}>
              <View style={[styles.avatar, { backgroundColor: statusColor + "20" }]}>
                <Text style={[styles.avatarText, { color: statusColor }]}>
                  {lead.firstName?.[0]}{lead.lastName?.[0]}
                </Text>
              </View>
              <View style={styles.contactInfo}>
                <View style={styles.nameRow}>
                  <Text style={[styles.contactName, { color: colors.foreground }]}>
                    {lead.firstName} {lead.lastName}
                  </Text>
                  {dayBadge && (
                    <View style={[styles.dayBadge, { backgroundColor: dayBadge.color + "20", borderColor: dayBadge.color + "30" }]}>
                      <Text style={[styles.dayBadgeText, { color: dayBadge.color }]}>{dayBadge.label}</Text>
                    </View>
                  )}
                </View>
                {lead.assignedUserName && (
                  <Text style={[styles.assignedText, { color: colors.mutedForeground }]}>
                    Assigned: {lead.assignedUserName}
                  </Text>
                )}
              </View>
            </View>

            {contactPrefs.length > 0 && (
              <View style={styles.flagsRow}>
                {contactPrefs.map(pref => {
                  const cfg = CONTACT_FLAGS[pref];
                  if (!cfg) return null;
                  return (
                    <View key={pref} style={[styles.flagBadge, { backgroundColor: cfg.color + "20" }]}>
                      <Feather name={cfg.icon} size={11} color={cfg.color} />
                      <Text style={[styles.flagText, { color: cfg.color }]}>{cfg.label}</Text>
                    </View>
                  );
                })}
              </View>
            )}

            <View style={styles.contactActions}>
              <TouchableOpacity
                style={[styles.contactBtn, { backgroundColor: colors.emerald + "15" }]}
                onPress={dialPhone}
                activeOpacity={0.7}
              >
                <Feather name="phone" size={20} color={colors.emerald} />
                <Text style={[styles.contactBtnText, { color: colors.emerald }]}>Call</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.contactBtn, { backgroundColor: colors.primary + "15" }]}
                onPress={sendSMS}
                activeOpacity={0.7}
              >
                <Feather name="message-square" size={20} color={colors.primary} />
                <Text style={[styles.contactBtnText, { color: colors.primary }]}>Text</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.detailRows}>
              {lead.phone && (
                <View style={styles.detailRow}>
                  <Feather name="phone" size={14} color={colors.mutedForeground} />
                  <Text style={[styles.detailText, { color: colors.foreground }]}>{formatPhone(lead.phone)}</Text>
                </View>
              )}
              {lead.email && (
                <View style={styles.detailRow}>
                  <Feather name="mail" size={14} color={colors.mutedForeground} />
                  <Text style={[styles.detailText, { color: colors.foreground }]}>{lead.email}</Text>
                </View>
              )}
              {lead.source && (
                <View style={styles.detailRow}>
                  <Feather name="target" size={14} color={colors.mutedForeground} />
                  <Text style={[styles.detailText, { color: colors.foreground }]}>{lead.source}</Text>
                </View>
              )}
              {lead.interestType && (
                <View style={styles.detailRow}>
                  <Feather name="tag" size={14} color={colors.mutedForeground} />
                  <Text style={[styles.detailText, { color: colors.foreground }]}>{lead.interestType}</Text>
                </View>
              )}
            </View>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.tabScroll, { borderBottomColor: colors.border }]}
            contentContainerStyle={styles.tabScrollContent}
          >
            {DETAIL_TABS.map(tab => {
              const isActive = activeTab === tab.key;
              return (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.detailTab, isActive && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
                  onPress={() => setActiveTab(tab.key)}
                  activeOpacity={0.7}
                >
                  <Feather name={tab.icon} size={14} color={isActive ? colors.primary : colors.mutedForeground} />
                  <Text style={[styles.detailTabLabel, { color: isActive ? colors.primary : colors.mutedForeground }]}>
                    {tab.label}
                  </Text>
                  {tab.badge != null && tab.badge > 0 && (
                    <View style={[styles.tabBadge, { backgroundColor: isActive ? colors.primary + "20" : colors.secondary }]}>
                      <Text style={[styles.tabBadgeText, { color: isActive ? colors.primary : colors.mutedForeground }]}>
                        {tab.badge}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {activeTab === "actions" && !isTerminal && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Log Action</Text>

              <View style={styles.actionTypeTabs}>
                {(["call", "text", "voicemail_drop"] as ActionType[]).map(at => (
                  <TouchableOpacity
                    key={at}
                    style={[
                      styles.actionTypeTab,
                      { backgroundColor: actionType === at ? colors.primary : colors.secondary },
                    ]}
                    onPress={() => setActionType(at)}
                  >
                    <Feather
                      name={at === "call" ? "phone" : at === "text" ? "message-square" : "voicemail"}
                      size={14}
                      color={actionType === at ? colors.primaryForeground : colors.mutedForeground}
                    />
                    <Text style={[styles.actionTypeText, { color: actionType === at ? colors.primaryForeground : colors.mutedForeground }]}>
                      {at === "call" ? "Call" : at === "text" ? "Text" : "VM Drop"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TextInput
                style={[styles.notesInput, { backgroundColor: colors.background, color: colors.foreground, borderColor: colors.border }]}
                placeholder="Notes (optional)"
                placeholderTextColor={colors.mutedForeground}
                value={notes}
                onChangeText={setNotes}
                multiline
              />

              {actionType === "voicemail_drop" ? (
                <TouchableOpacity
                  style={[styles.resultBtn, { backgroundColor: colors.primary }]}
                  onPress={() => submitAction("yes")}
                  disabled={submitting}
                >
                  <Feather name="voicemail" size={16} color={colors.primaryForeground} />
                  <Text style={[styles.resultBtnText, { color: colors.primaryForeground }]}>Drop Voicemail</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.resultGrid}>
                  {results.map(r => (
                    <TouchableOpacity
                      key={r.key}
                      style={[styles.resultBtn, { backgroundColor: colors.secondary }]}
                      onPress={() => submitAction(r.key)}
                      disabled={submitting}
                      activeOpacity={0.7}
                    >
                      <Feather name={r.icon} size={14} color={colors.foreground} />
                      <Text style={[styles.resultBtnText, { color: colors.foreground }]}>{r.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <View style={[styles.callbackSection, { borderTopColor: colors.border }]}>
                <Text style={[styles.callbackTitle, { color: colors.foreground }]}>Schedule Callback</Text>
                <TextInput
                  style={[styles.callbackInput, { backgroundColor: colors.background, color: colors.foreground, borderColor: colors.border }]}
                  placeholder="YYYY-MM-DD HH:MM"
                  placeholderTextColor={colors.mutedForeground}
                  value={callbackDate}
                  onChangeText={setCallbackDate}
                />
                <TouchableOpacity
                  style={[styles.callbackBtn, { backgroundColor: "#F59E0B" }]}
                  onPress={scheduleCallback}
                  disabled={submitting}
                >
                  <Feather name="clock" size={14} color="#FFF" />
                  <Text style={styles.callbackBtnText}>Set Callback</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.deadBtn, { borderColor: colors.destructive }]}
                onPress={() => setShowDeadMenu(!showDeadMenu)}
              >
                <Feather name="x-circle" size={14} color={colors.destructive} />
                <Text style={[styles.deadBtnText, { color: colors.destructive }]}>Mark Dead</Text>
              </TouchableOpacity>

              {showDeadMenu && (
                <View style={styles.deadReasons}>
                  {DEAD_REASONS.map(r => (
                    <TouchableOpacity
                      key={r.key}
                      style={[styles.deadReasonBtn, { backgroundColor: colors.destructive + "10" }]}
                      onPress={() => markDead(r.key)}
                    >
                      <Text style={[styles.deadReasonText, { color: colors.destructive }]}>{r.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          )}

          {activeTab === "actions" && isTerminal && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.terminalState}>
                <Feather
                  name={lead.hubStatus === "appt_set" ? "check-circle" : "x-circle"}
                  size={32}
                  color={statusColor}
                />
                <Text style={[styles.terminalText, { color: colors.foreground }]}>
                  {lead.hubStatus === "appt_set" ? "Appointment Set" : "Lead Marked Dead"}
                </Text>
              </View>
            </View>
          )}

          {activeTab === "details" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Lead Details</Text>

              {lead.appointmentDate && (
                <View style={[styles.detailBlock, { backgroundColor: "#10B98110" }]}>
                  <Feather name="calendar" size={16} color="#10B981" />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.detailBlockLabel, { color: "#10B981" }]}>Appointment</Text>
                    <Text style={[styles.detailBlockValue, { color: colors.foreground }]}>
                      {lead.appointmentDate}{lead.appointmentTime ? ` at ${lead.appointmentTime}` : ""}
                    </Text>
                  </View>
                </View>
              )}

              {lead.callbackAt && (
                <View style={[styles.detailBlock, { backgroundColor: "#F59E0B10" }]}>
                  <Feather name="clock" size={16} color="#F59E0B" />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.detailBlockLabel, { color: "#F59E0B" }]}>Callback Scheduled</Text>
                    <Text style={[styles.detailBlockValue, { color: colors.foreground }]}>
                      {new Date(lead.callbackAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </Text>
                  </View>
                </View>
              )}

              {lead.address && (
                <View style={styles.detailFieldRow}>
                  <Feather name="map-pin" size={14} color={colors.mutedForeground} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.detailFieldLabel, { color: colors.mutedForeground }]}>Address</Text>
                    <Text style={[styles.detailFieldValue, { color: colors.foreground }]}>
                      {lead.address}{lead.city ? `, ${lead.city}` : ""}{lead.state ? `, ${lead.state}` : ""}
                    </Text>
                  </View>
                </View>
              )}

              {lead.addOns && (
                <View style={styles.detailFieldRow}>
                  <Feather name="plus-circle" size={14} color={colors.mutedForeground} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.detailFieldLabel, { color: colors.mutedForeground }]}>Add-Ons</Text>
                    <Text style={[styles.detailFieldValue, { color: colors.foreground }]}>{lead.addOns}</Text>
                  </View>
                </View>
              )}

              {lead.leadType && (
                <View style={styles.detailFieldRow}>
                  <Feather name="layers" size={14} color={colors.mutedForeground} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.detailFieldLabel, { color: colors.mutedForeground }]}>Lead Type</Text>
                    <Text style={[styles.detailFieldValue, { color: colors.foreground }]}>{lead.leadType}</Text>
                  </View>
                </View>
              )}

              <View style={styles.detailFieldRow}>
                <Feather name="hash" size={14} color={colors.mutedForeground} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.detailFieldLabel, { color: colors.mutedForeground }]}>Attempts</Text>
                  <Text style={[styles.detailFieldValue, { color: colors.foreground }]}>{lead.attemptCount ?? 0}</Text>
                </View>
              </View>

              {lead.createdAt && (
                <View style={styles.detailFieldRow}>
                  <Feather name="clock" size={14} color={colors.mutedForeground} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.detailFieldLabel, { color: colors.mutedForeground }]}>Created</Text>
                    <Text style={[styles.detailFieldValue, { color: colors.foreground }]}>
                      {new Date(lead.createdAt).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                    </Text>
                  </View>
                </View>
              )}

              {lead.notes && (
                <View style={[styles.notesBlock, { borderTopColor: colors.border }]}>
                  <Text style={[styles.notesLabel, { color: colors.mutedForeground }]}>Notes</Text>
                  <Text style={[styles.notesContent, { color: colors.foreground }]}>{lead.notes}</Text>
                </View>
              )}
            </View>
          )}

          {activeTab === "messages" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.messagesHeader}>
                <Feather name="message-circle" size={18} color="#8B5CF6" />
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Podium Messages</Text>
              </View>

              {messages.length === 0 ? (
                <View style={styles.emptyMessages}>
                  <Feather name="message-square" size={32} color={colors.mutedForeground} />
                  <Text style={[styles.emptyMsgText, { color: colors.mutedForeground }]}>No messages yet</Text>
                  <Text style={[styles.emptyMsgSub, { color: colors.mutedForeground }]}>
                    Send a message below to start a conversation
                  </Text>
                </View>
              ) : (
                <View style={styles.messagesList}>
                  {messages.map(msg => (
                    <View
                      key={msg.id}
                      style={[
                        styles.messageBubble,
                        msg.direction === "outbound"
                          ? { backgroundColor: colors.primary + "15", alignSelf: "flex-end" }
                          : { backgroundColor: colors.secondary, alignSelf: "flex-start" },
                      ]}
                    >
                      {msg.channelType === "call" || msg.channelType === "phone_call" ? (
                        <View style={styles.callEntry}>
                          <Feather name="phone" size={12} color={colors.mutedForeground} />
                          <Text style={[styles.callEntryText, { color: colors.mutedForeground }]}>
                            {msg.direction === "outbound" ? "Outgoing" : "Incoming"} Call
                          </Text>
                        </View>
                      ) : (
                        <Text style={[styles.msgBody, { color: colors.foreground }]}>{msg.body}</Text>
                      )}
                      <Text style={[styles.msgTime, { color: colors.mutedForeground }]}>
                        {new Date(msg.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              <View style={[styles.msgInputRow, { borderTopColor: colors.border }]}>
                <TextInput
                  style={[styles.msgInput, { backgroundColor: colors.background, color: colors.foreground, borderColor: colors.border }]}
                  placeholder="Type a message..."
                  placeholderTextColor={colors.mutedForeground}
                  value={newMessage}
                  onChangeText={setNewMessage}
                  multiline
                />
                <TouchableOpacity
                  style={[styles.sendBtn, { backgroundColor: colors.primary, opacity: sendingMsg || !newMessage.trim() ? 0.5 : 1 }]}
                  onPress={sendPodiumMessage}
                  disabled={sendingMsg || !newMessage.trim()}
                >
                  {sendingMsg ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <Feather name="send" size={16} color="#FFF" />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {activeTab === "history" && (
            <View style={styles.historyContainer}>
              {history.length === 0 ? (
                <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={styles.emptyMessages}>
                    <Feather name="clock" size={32} color={colors.mutedForeground} />
                    <Text style={[styles.emptyMsgText, { color: colors.mutedForeground }]}>No activity yet</Text>
                  </View>
                </View>
              ) : (
                history.map(item => (
                  <View key={item.id} style={[styles.historyItem, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <View style={styles.historyHeader}>
                      <View style={[styles.historyIcon, { backgroundColor: colors.primary + "15" }]}>
                        <Feather
                          name={item.actionType === "call" ? "phone" : item.actionType === "text" ? "message-square" : "voicemail"}
                          size={12}
                          color={colors.primary}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.historyAction, { color: colors.foreground }]}>
                          {item.actionType} — {(item.outcome || "").replace(/_/g, " ")}
                        </Text>
                        <Text style={[styles.historyMeta, { color: colors.mutedForeground }]}>
                          {item.userName ? `${item.userName} • ` : ""}
                          {new Date(item.attemptedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </Text>
                      </View>
                    </View>
                    {item.notes && <Text style={[styles.historyNotes, { color: colors.foreground }]}>{item.notes}</Text>}
                  </View>
                ))
              )}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  contactCard: { margin: 16, marginBottom: 0, padding: 16, borderRadius: 14, borderWidth: 1, gap: 14 },
  contactHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 18, fontFamily: "Inter_700Bold" },
  contactInfo: { flex: 1, gap: 4 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  contactName: { fontSize: 18, fontFamily: "Inter_700Bold", flexShrink: 1 },
  dayBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  dayBadgeText: { fontSize: 10, fontFamily: "Inter_700Bold" },
  assignedText: { fontSize: 12, fontFamily: "Inter_400Regular" },
  flagsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  flagBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5 },
  flagText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  contactActions: { flexDirection: "row", gap: 10 },
  contactBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 10 },
  contactBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  detailRows: { gap: 8 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  detailText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  tabScroll: { borderBottomWidth: 1, marginHorizontal: 16, marginTop: 12, marginBottom: 4 },
  tabScrollContent: { gap: 2 },
  detailTab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 10,
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  detailTabLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  tabBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6, minWidth: 18, alignItems: "center" },
  tabBadgeText: { fontSize: 10, fontFamily: "Inter_700Bold" },
  actionCard: { marginHorizontal: 16, marginTop: 8, marginBottom: 12, padding: 16, borderRadius: 14, borderWidth: 1, gap: 12 },
  sectionTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  actionTypeTabs: { flexDirection: "row", gap: 8 },
  actionTypeTab: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 10 },
  actionTypeText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  notesInput: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 14, fontFamily: "Inter_400Regular", minHeight: 60, textAlignVertical: "top" },
  resultGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  resultBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, minWidth: 100 },
  resultBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  callbackSection: { borderTopWidth: 1, paddingTop: 12, gap: 8 },
  callbackTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  callbackInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, fontFamily: "Inter_400Regular" },
  callbackBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8 },
  callbackBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#FFF" },
  deadBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  deadBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  deadReasons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  deadReasonBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  deadReasonText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  terminalState: { alignItems: "center", gap: 8, paddingVertical: 20 },
  terminalText: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  detailBlock: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 10 },
  detailBlockLabel: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  detailBlockValue: { fontSize: 14, fontFamily: "Inter_500Medium" },
  detailFieldRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 6 },
  detailFieldLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  detailFieldValue: { fontSize: 14, fontFamily: "Inter_400Regular" },
  notesBlock: { borderTopWidth: 1, paddingTop: 12 },
  notesLabel: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.5, marginBottom: 4 },
  notesContent: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  messagesHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  emptyMessages: { alignItems: "center", paddingVertical: 24, gap: 8 },
  emptyMsgText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  emptyMsgSub: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" },
  messagesList: { gap: 8 },
  messageBubble: { maxWidth: "80%", padding: 10, borderRadius: 12, gap: 4 },
  callEntry: { flexDirection: "row", alignItems: "center", gap: 6 },
  callEntryText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  msgBody: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  msgTime: { fontSize: 10, fontFamily: "Inter_400Regular" },
  msgInputRow: { flexDirection: "row", gap: 8, paddingTop: 12, borderTopWidth: 1, alignItems: "flex-end" },
  msgInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, fontFamily: "Inter_400Regular", maxHeight: 80 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  historyContainer: { paddingHorizontal: 16, gap: 6, marginTop: 8 },
  historyItem: { padding: 12, borderRadius: 10, borderWidth: 1, gap: 4 },
  historyHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  historyIcon: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  historyAction: { fontSize: 14, fontFamily: "Inter_500Medium", textTransform: "capitalize" as const },
  historyMeta: { fontSize: 12, fontFamily: "Inter_400Regular" },
  historyNotes: { fontSize: 13, fontFamily: "Inter_400Regular", fontStyle: "italic" as const, marginLeft: 36 },
});
