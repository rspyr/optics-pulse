import React, { useCallback, useEffect, useRef, useState } from "react";
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
  Modal,
  Dimensions,
  LayoutChangeEvent,
} from "react-native";
import { useLocalSearchParams, router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useApi } from "@/hooks/useApi";
import { useColors } from "@/hooks/useColors";
import { useSocket } from "@/contexts/SocketContext";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/contexts/AuthContext";

type ActionStep =
  | null
  | "call_done"
  | "spoke_result"
  | "call_callback"
  | "dead_reason"
  | "text_done"
  | "vm_done"
  | "appt_booked_flow"
  | "appt_cancel_reason";

type DetailTab = "actions" | "details" | "messages" | "history";

const CALL_RESULTS = [
  { value: "no_answer", label: "No Answer" },
  { value: "left_voicemail", label: "Left Voicemail" },
  { value: "vm_full", label: "VM Full" },
  { value: "vm_not_setup", label: "VM Not Setup" },
  { value: "hung_up", label: "Hung Up" },
  { value: "spoke_with_customer", label: "Spoke with Customer" },
];

const SPOKE_RESULTS = [
  { value: "appointment_set", label: "Appointment Set", color: "#10B981" },
  { value: "call_back", label: "Callback Requested", color: "#F59E0B" },
  { value: "dead", label: "Dead Lead", color: "#EF4444" },
];

const TEXT_RESULTS = [
  { value: "yes", label: "Yes — Interested" },
  { value: "reached_out", label: "Reached Out" },
  { value: "not_able_to", label: "Not Able To" },
  { value: "dead", label: "Dead Lead" },
  { value: "no_need", label: "No Need to Log" },
];

const VM_RESULTS = [
  { value: "yes", label: "VM Dropped" },
  { value: "no", label: "No — Did Not Leave VM" },
  { value: "bad_number", label: "Bad Number" },
  { value: "vm_full", label: "VM Full" },
  { value: "vm_not_setup", label: "VM Not Setup" },
  { value: "spoke_with_customer", label: "Spoke with Customer" },
];

const DEAD_REASONS = [
  { value: "out_of_service_area", label: "Out of Service Area" },
  { value: "do_not_call", label: "Do Not Call" },
  { value: "not_interested", label: "Not Interested" },
  { value: "too_expensive", label: "Too Expensive" },
  { value: "no_response", label: "No Response" },
  { value: "other", label: "Other" },
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

const CONTACT_FLAG_CONFIG: Record<string, { label: string; icon: keyof typeof Feather.glyphMap; color: string; blocksCall?: boolean }> = {
  text_only: { label: "Text Only", icon: "message-square", color: "#3B82F6", blocksCall: true },
  spanish_speaking: { label: "Spanish", icon: "globe", color: "#8B5CF6" },
  do_not_call: { label: "DNC", icon: "phone-off", color: "#EF4444", blocksCall: true },
};

interface CsrOption {
  id: number;
  name: string;
}

interface LeadDetail {
  id: number;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  source?: string;
  leadType?: string;
  interestType?: string;
  serviceType?: string;
  hubStatus?: string;
  dayInSequence?: number;
  createdAt?: string;
  notes?: string;
  assignedUserName?: string;
  assignedCsrId?: number;
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
  const { user } = useAuth();
  const isWeb = Platform.OS === "web";
  const tenantQs = effectiveTenantId ? `?tenantId=${effectiveTenantId}` : "";
  const isManager = ["client_admin", "agency_user", "super_admin"].includes(user?.role || "");

  const [lead, setLead] = useState<LeadDetail | null>(() => {
    if (params.lead) {
      try { return JSON.parse(params.lead); } catch { return null; }
    }
    return null;
  });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [messages, setMessages] = useState<PodiumMessage[]>([]);
  const [activeTab, setActiveTab] = useState<DetailTab>("actions");
  const [newMessage, setNewMessage] = useState("");
  const [sendingMsg, setSendingMsg] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [actionStep, setActionStep] = useState<ActionStep>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [deadFromFlow, setDeadFromFlow] = useState<"call" | "text">("call");
  const [apptBookedChannel, setApptBookedChannel] = useState<"call" | "text" | "voicemail_drop">("call");
  const [callbackDate, setCallbackDate] = useState<Date>(new Date(Date.now() + 3600000));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const [showTransfer, setShowTransfer] = useState(false);
  const [csrs, setCsrs] = useState<CsrOption[]>([]);
  const [selectedCsr, setSelectedCsr] = useState<number | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const detailTabScrollRef = useRef<ScrollView>(null);
  const detailTabLayouts = useRef<Record<string, { x: number; width: number }>>({});
  const detailScrollViewWidth = useRef(Dimensions.get("window").width);

  const handleDetailTabLayout = useCallback((key: string, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    detailTabLayouts.current[key] = { x, width };
  }, []);

  const handleDetailScrollViewLayout = useCallback((event: LayoutChangeEvent) => {
    detailScrollViewWidth.current = event.nativeEvent.layout.width;
  }, []);

  const scrollDetailTabIntoView = useCallback((tabKey: string) => {
    const layout = detailTabLayouts.current[tabKey];
    if (!layout || !detailTabScrollRef.current) return;

    const viewWidth = detailScrollViewWidth.current;
    const tabCenter = layout.x + layout.width / 2;
    const scrollTarget = tabCenter - viewWidth / 2;
    const clampedTarget = Math.max(0, scrollTarget);

    detailTabScrollRef.current.scrollTo({ x: clampedTarget, animated: true });
  }, []);

  const contactPrefs = (lead?.contactPreferences || []) as string[];
  const blocksCall = contactPrefs.some(p => CONTACT_FLAG_CONFIG[p]?.blocksCall);

  const showFeedback = (type: "success" | "error", msg: string) => {
    setFeedback({ type, msg });
    setTimeout(() => setFeedback(null), 3000);
  };

  const fetchLead = useCallback(async () => {
    try {
      setFetchError(null);
      const data = await apiFetch(`/api/leads/${params.id}${tenantQs}`);
      setLead(data);
      return true;
    } catch (err) {
      console.error("[LeadDetail] Failed to fetch lead:", err);
      setFetchError(err instanceof Error ? err.message : "Failed to load lead");
      return false;
    }
  }, [apiFetch, params.id, tenantQs]);

  const fetchHistory = useCallback(async () => {
    try {
      setHistoryError(null);
      const data = await apiFetch(`/api/leads-hub/${params.id}/history${tenantQs}`);
      setHistory(data.attempts || []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load history";
      if (msg.includes("Lead not found") || msg.includes("404")) {
        setHistoryError("Lead not found — history unavailable");
      } else {
        setHistoryError(msg);
      }
    }
  }, [apiFetch, params.id, tenantQs]);

  const fetchMessages = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/podium/conversations/${params.id}${tenantQs}`);
      setMessages(data.messages || []);
    } catch {}
  }, [apiFetch, params.id, tenantQs]);

  useEffect(() => {
    const init = async () => {
      const hasLead = lead ? true : await fetchLead();
      if (hasLead) {
        fetchHistory();
      }
      fetchMessages();
    };
    init();
  }, []);

  useEffect(() => {
    if (isManager && effectiveTenantId) {
      apiFetch(`/api/leads-hub/csrs${tenantQs}`)
        .then(d => setCsrs(d.csrs || []))
        .catch(() => {});
    }
  }, [effectiveTenantId, tenantQs, isManager]);

  useEffect(() => {
    const handler = (data: { leadId?: number }) => {
      if (data?.leadId === Number(params.id)) {
        fetchMessages();
      }
    };
    on("podium-message", handler);
    return () => off("podium-message", handler);
  }, [on, off, params.id, fetchMessages]);

  const logAction = async (body: Record<string, unknown>) => {
    setActionLoading(true);
    try {
      const res = await apiFetch("/api/leads-hub/action" + tenantQs, {
        method: "POST",
        body: JSON.stringify({ leadId: Number(params.id), ...body }),
      });
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showFeedback("success", `Action logged — ${res.lead?.hubStatus || "updated"}`);
      setActionStep(null);
      setCallbackDate(new Date(Date.now() + 3600000));
      setCancelReason("");
      fetchLead();
      fetchHistory();
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to log action");
    } finally {
      setActionLoading(false);
    }
  };

  const handleCall = () => {
    if (blocksCall) {
      showFeedback("error", "This lead has a contact restriction that prevents calls");
      return;
    }
    if (lead?.phone) Linking.openURL(`tel:${lead.phone.replace(/\D/g, "")}`);
    if (lead?.hubStatus === "appt_booked") {
      setApptBookedChannel("call");
      setActionStep("appt_booked_flow");
    } else {
      setActionStep("call_done");
    }
  };

  const handleText = () => {
    if (lead?.phone) Linking.openURL(`sms:${lead.phone.replace(/\D/g, "")}`);
    if (lead?.hubStatus === "appt_booked") {
      setApptBookedChannel("text");
      setActionStep("appt_booked_flow");
    } else {
      setActionStep("text_done");
    }
  };

  const handleVmDrop = () => {
    if (blocksCall) {
      showFeedback("error", "This lead has a contact restriction that prevents calls");
      return;
    }
    if (lead?.hubStatus === "appt_booked") {
      setApptBookedChannel("voicemail_drop");
      setActionStep("appt_booked_flow");
    } else {
      setActionStep("vm_done");
    }
  };

  const handleTransfer = async () => {
    if (!selectedCsr) return;
    setActionLoading(true);
    try {
      await apiFetch(`/api/leads-hub/${params.id}/transfer${tenantQs}`, {
        method: "POST",
        body: JSON.stringify({ targetCsrId: selectedCsr }),
      });
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showFeedback("success", "Lead transferred");
      setShowTransfer(false);
      setSelectedCsr(null);
      fetchLead();
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setActionLoading(false);
    }
  };

  const sendPodiumMessage = async () => {
    if (!newMessage.trim() || sendingMsg) return;
    setSendingMsg(true);
    try {
      await apiFetch("/api/podium/messages" + tenantQs, {
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

  if (!lead) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        {fetchError ? (
          <>
            <Feather name="alert-circle" size={48} color={colors.red} />
            <Text style={{ color: colors.foreground, marginTop: 12, fontSize: 16 }}>{fetchError}</Text>
            <TouchableOpacity onPress={async () => { const ok = await fetchLead(); if (ok) { fetchHistory(); fetchMessages(); } }} style={{ marginTop: 16, padding: 12, backgroundColor: colors.primary, borderRadius: 8 }}>
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
  const isTerminal = lead.hubStatus === "appt_set" || lead.hubStatus === "dead";

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
                {lead.dayInSequence != null && (
                  <Text style={[styles.assignedText, { color: colors.mutedForeground }]}>
                    Day {lead.dayInSequence}
                  </Text>
                )}
                {lead.assignedUserName && (
                  <Text style={[styles.assignedText, { color: colors.mutedForeground }]}>
                    Assigned: {lead.assignedUserName}
                  </Text>
                )}
              </View>
              {isManager && (
                <TouchableOpacity
                  style={[styles.transferBtn, { backgroundColor: colors.secondary }]}
                  onPress={() => setShowTransfer(!showTransfer)}
                >
                  <Feather name="user-plus" size={14} color={colors.mutedForeground} />
                </TouchableOpacity>
              )}
            </View>

            {contactPrefs.length > 0 && (
              <View style={styles.flagsRow}>
                {contactPrefs.map(pref => {
                  const cfg = CONTACT_FLAG_CONFIG[pref];
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

            {blocksCall && (
              <View style={[styles.blockedWarning, { backgroundColor: "#EF444410", borderColor: "#EF444430" }]}>
                <Feather name="alert-circle" size={14} color="#EF4444" />
                <Text style={styles.blockedWarningText}>
                  This lead has a "Text Only" or "Do Not Call" flag. Calling is blocked.
                </Text>
              </View>
            )}

            <View style={styles.contactActions}>
              <TouchableOpacity
                style={[
                  styles.contactBtn,
                  blocksCall
                    ? { backgroundColor: "#EF444410", borderWidth: 1, borderColor: "#EF444430" }
                    : { backgroundColor: colors.emerald + "15" },
                  (blocksCall || !lead.phone || actionStep !== null) && { opacity: 0.5 },
                ]}
                onPress={handleCall}
                disabled={blocksCall || !lead.phone || actionStep !== null}
                activeOpacity={0.7}
              >
                <Feather name={blocksCall ? "slash" : "phone"} size={18} color={blocksCall ? "#EF4444" : colors.emerald} />
                <Text style={[styles.contactBtnText, { color: blocksCall ? "#EF4444" : colors.emerald }]}>CALL</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.contactBtn,
                  { backgroundColor: "#3B82F615" },
                  (!lead.phone || actionStep !== null) && { opacity: 0.5 },
                ]}
                onPress={handleText}
                disabled={!lead.phone || actionStep !== null}
                activeOpacity={0.7}
              >
                <Feather name="message-square" size={18} color="#3B82F6" />
                <Text style={[styles.contactBtnText, { color: "#3B82F6" }]}>TEXT</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.contactBtn,
                  blocksCall
                    ? { backgroundColor: "#EF444410", borderWidth: 1, borderColor: "#EF444430" }
                    : { backgroundColor: "#F9731615" },
                  (actionStep !== null || blocksCall) && { opacity: 0.5 },
                ]}
                onPress={handleVmDrop}
                disabled={actionStep !== null || blocksCall}
                activeOpacity={0.7}
              >
                <Feather name={blocksCall ? "slash" : "voicemail"} size={18} color={blocksCall ? "#EF4444" : "#F97316"} />
                <Text style={[styles.contactBtnText, { color: blocksCall ? "#EF4444" : "#F97316" }]}>VM</Text>
              </TouchableOpacity>
            </View>

            {lead.callbackAt && (
              <View style={[styles.callbackBanner, { backgroundColor: "#F59E0B15" }]}>
                <Feather name="calendar" size={14} color="#F59E0B" />
                <Text style={styles.callbackBannerText}>
                  Callback: {new Date(lead.callbackAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </Text>
              </View>
            )}

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

          <Modal
            visible={showTransfer}
            transparent
            animationType="slide"
            onRequestClose={() => setShowTransfer(false)}
          >
            <View style={styles.modalOverlay}>
              <View style={[styles.modalSheet, { backgroundColor: colors.card }]}>
                <View style={styles.modalHandle} />
                <Text style={[styles.modalTitle, { color: colors.foreground }]}>Transfer Lead</Text>
                <Text style={[styles.transferTitle, { color: colors.mutedForeground }]}>Select a CSR to transfer this lead to:</Text>
                <ScrollView style={styles.transferScrollList}>
                  {csrs.filter(c => c.id !== lead.assignedCsrId).map(c => (
                    <TouchableOpacity
                      key={c.id}
                      style={[
                        styles.transferItem,
                        { backgroundColor: selectedCsr === c.id ? colors.primary + "20" : colors.secondary, borderColor: selectedCsr === c.id ? colors.primary + "40" : colors.border },
                      ]}
                      onPress={() => setSelectedCsr(c.id)}
                    >
                      <View style={styles.transferItemRow}>
                        <View style={[styles.transferAvatar, { backgroundColor: colors.primary + "15" }]}>
                          <Text style={[styles.transferAvatarText, { color: colors.primary }]}>{c.name.charAt(0)}</Text>
                        </View>
                        <Text style={[styles.transferItemText, { color: selectedCsr === c.id ? colors.primary : colors.foreground }]}>{c.name}</Text>
                      </View>
                      {selectedCsr === c.id && <Feather name="check-circle" size={18} color={colors.primary} />}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={[styles.modalCancelBtn, { borderColor: colors.border }]}
                    onPress={() => { setShowTransfer(false); setSelectedCsr(null); }}
                  >
                    <Text style={[styles.modalCancelText, { color: colors.mutedForeground }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.transferConfirmBtn, { backgroundColor: colors.primary, opacity: !selectedCsr || actionLoading ? 0.5 : 1 }]}
                    onPress={handleTransfer}
                    disabled={!selectedCsr || actionLoading}
                  >
                    {actionLoading ? (
                      <ActivityIndicator size="small" color="#FFF" />
                    ) : (
                      <Text style={styles.transferConfirmText}>Transfer</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>

          {feedback && (
            <View style={[
              styles.feedbackBar,
              { backgroundColor: feedback.type === "success" ? "#10B98115" : "#EF444415", borderColor: feedback.type === "success" ? "#10B98130" : "#EF444430" },
            ]}>
              <Feather name={feedback.type === "success" ? "check-circle" : "x-circle"} size={16} color={feedback.type === "success" ? "#10B981" : "#EF4444"} />
              <Text style={[styles.feedbackText, { color: feedback.type === "success" ? "#10B981" : "#EF4444" }]}>{feedback.msg}</Text>
            </View>
          )}

          {actionStep === "appt_booked_flow" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.stepHeader}>
                <Feather name="calendar" size={20} color="#8B5CF6" />
                <Text style={[styles.stepTitle, { color: "#8B5CF6" }]}>PRE-BOOKED APPOINTMENT</Text>
              </View>
              <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>Confirm the appointment status after reaching the lead:</Text>
              <TouchableOpacity
                style={[styles.outcomeBtn, { backgroundColor: "#10B98115", borderColor: "#10B98125" }]}
                onPress={() => logAction({ actionType: apptBookedChannel, apptBookedOutcome: "confirmed" })}
                disabled={actionLoading}
              >
                {actionLoading ? <ActivityIndicator size="small" color="#10B981" /> : <Feather name="check-circle" size={16} color="#10B981" />}
                <Text style={[styles.outcomeBtnText, { color: "#10B981" }]}>Confirmed</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.outcomeBtn, { backgroundColor: "#F59E0B15", borderColor: "#F59E0B25" }]}
                onPress={() => logAction({ actionType: apptBookedChannel, apptBookedOutcome: "rescheduled" })}
                disabled={actionLoading}
              >
                {actionLoading ? <ActivityIndicator size="small" color="#F59E0B" /> : <Feather name="calendar" size={16} color="#F59E0B" />}
                <Text style={[styles.outcomeBtnText, { color: "#F59E0B" }]}>Rescheduled</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.outcomeBtn, { backgroundColor: "#EF444410", borderColor: "#EF444420" }]}
                onPress={() => { setCancelReason(""); setActionStep("appt_cancel_reason"); }}
                disabled={actionLoading}
              >
                <Feather name="x-circle" size={16} color="#EF4444" />
                <Text style={[styles.outcomeBtnText, { color: "#EF4444" }]}>Canceled</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setActionStep(null)}>
                <Text style={[styles.backLink, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {actionStep === "appt_cancel_reason" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>Why was the appointment canceled?</Text>
              <TextInput
                style={[styles.cancelInput, { backgroundColor: colors.background, color: colors.foreground, borderColor: colors.border }]}
                placeholder="Enter reason for cancellation..."
                placeholderTextColor={colors.mutedForeground}
                value={cancelReason}
                onChangeText={setCancelReason}
                multiline
              />
              <TouchableOpacity
                style={[styles.outcomeBtn, { backgroundColor: "#EF444420", borderColor: "#EF444430" }]}
                onPress={() => logAction({ actionType: apptBookedChannel, apptBookedOutcome: "canceled", cancelReason: cancelReason || "appointment_canceled" })}
                disabled={actionLoading}
              >
                {actionLoading ? <ActivityIndicator size="small" color="#EF4444" /> : <Text style={[styles.outcomeBtnText, { color: "#EF4444" }]}>Confirm Cancellation</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setActionStep("appt_booked_flow")}>
                <Text style={[styles.backLink, { color: colors.mutedForeground }]}>Back</Text>
              </TouchableOpacity>
            </View>
          )}

          {actionStep === "call_done" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.stepHeader}>
                <Feather name="check-circle" size={20} color="#10B981" />
                <Text style={[styles.stepTitle, { color: "#10B981" }]}>CALLED</Text>
              </View>
              <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>How'd it go?</Text>
              <View style={styles.resultGrid}>
                {CALL_RESULTS.map(r => (
                  <TouchableOpacity
                    key={r.value}
                    style={[styles.resultGridItem, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                    onPress={() => {
                      if (r.value === "spoke_with_customer") {
                        setActionStep("spoke_result");
                      } else {
                        logAction({ actionType: "call", callResult: r.value });
                      }
                    }}
                    disabled={actionLoading}
                  >
                    <Text style={[styles.resultGridText, { color: colors.foreground }]}>{r.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity onPress={() => setActionStep(null)}>
                <Text style={[styles.backLink, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {actionStep === "spoke_result" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>Spoke with customer — what happened?</Text>
              {SPOKE_RESULTS.map(r => (
                <TouchableOpacity
                  key={r.value}
                  style={[styles.outcomeBtn, { backgroundColor: r.color + "15", borderColor: r.color + "25" }]}
                  onPress={() => {
                    if (r.value === "appointment_set") {
                      logAction({ actionType: "call", callResult: "spoke_with_customer", appointmentSet: true });
                    } else if (r.value === "call_back") {
                      setCallbackDate(new Date(Date.now() + 3600000));
                      setActionStep("call_callback");
                    } else if (r.value === "dead") {
                      setDeadFromFlow("call");
                      setActionStep("dead_reason");
                    }
                  }}
                  disabled={actionLoading}
                >
                  <Text style={[styles.outcomeBtnText, { color: r.color }]}>{r.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={() => setActionStep("call_done")}>
                <Text style={[styles.backLink, { color: colors.mutedForeground }]}>Back</Text>
              </TouchableOpacity>
            </View>
          )}

          {actionStep === "call_callback" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>When should we call back?</Text>
              <TouchableOpacity
                style={[styles.datePickerBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                onPress={() => setShowDatePicker(true)}
              >
                <Feather name="calendar" size={16} color="#F59E0B" />
                <Text style={[styles.datePickerText, { color: colors.foreground }]}>
                  {callbackDate.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.datePickerBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                onPress={() => setShowTimePicker(true)}
              >
                <Feather name="clock" size={16} color="#F59E0B" />
                <Text style={[styles.datePickerText, { color: colors.foreground }]}>
                  {callbackDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </Text>
              </TouchableOpacity>
              {showDatePicker && (
                <DateTimePicker
                  value={callbackDate}
                  mode="date"
                  minimumDate={new Date()}
                  onChange={(_, date) => {
                    setShowDatePicker(false);
                    if (date) {
                      const updated = new Date(callbackDate);
                      updated.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
                      setCallbackDate(updated);
                    }
                  }}
                />
              )}
              {showTimePicker && (
                <DateTimePicker
                  value={callbackDate}
                  mode="time"
                  onChange={(_, date) => {
                    setShowTimePicker(false);
                    if (date) {
                      const updated = new Date(callbackDate);
                      updated.setHours(date.getHours(), date.getMinutes());
                      setCallbackDate(updated);
                    }
                  }}
                />
              )}
              <TouchableOpacity
                style={[styles.outcomeBtn, { backgroundColor: "#F59E0B20", borderColor: "#F59E0B30", opacity: actionLoading ? 0.5 : 1 }]}
                onPress={() => {
                  if (callbackDate.getTime() <= Date.now()) {
                    showFeedback("error", "Please select a future date/time");
                    return;
                  }
                  logAction({ actionType: "call", callResult: "spoke_with_customer", callbackAt: callbackDate.toISOString() });
                }}
                disabled={actionLoading}
              >
                {actionLoading ? <ActivityIndicator size="small" color="#F59E0B" /> : <Text style={[styles.outcomeBtnText, { color: "#F59E0B" }]}>Log Callback</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setActionStep("spoke_result")}>
                <Text style={[styles.backLink, { color: colors.mutedForeground }]}>Back</Text>
              </TouchableOpacity>
            </View>
          )}

          {actionStep === "dead_reason" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>
                {deadFromFlow === "call" ? "Why is this lead dead?" : "Why is this lead dead?"}
              </Text>
              {DEAD_REASONS.map(r => (
                <TouchableOpacity
                  key={r.value}
                  style={[styles.resultGridItem, { backgroundColor: "#EF444410", borderColor: "#EF444420" }]}
                  onPress={() => {
                    if (deadFromFlow === "call") {
                      logAction({ actionType: "call", callResult: "spoke_with_customer", deadReason: r.value });
                    } else {
                      logAction({ actionType: "text", textResult: "dead", deadReason: r.value });
                    }
                  }}
                  disabled={actionLoading}
                >
                  <Text style={[styles.resultGridText, { color: "#EF4444" }]}>{r.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={() => setActionStep(deadFromFlow === "call" ? "spoke_result" : "text_done")}>
                <Text style={[styles.backLink, { color: colors.mutedForeground }]}>Back</Text>
              </TouchableOpacity>
            </View>
          )}

          {actionStep === "text_done" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.stepHeader}>
                <Feather name="check-circle" size={20} color="#3B82F6" />
                <Text style={[styles.stepTitle, { color: "#3B82F6" }]}>TEXTED</Text>
              </View>
              <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>How'd it go?</Text>
              {TEXT_RESULTS.map(r => (
                <TouchableOpacity
                  key={r.value}
                  style={[styles.resultGridItem, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                  onPress={() => {
                    if (r.value === "no_need") {
                      setActionStep(null);
                    } else if (r.value === "dead") {
                      setDeadFromFlow("text");
                      setActionStep("dead_reason");
                    } else {
                      logAction({ actionType: "text", textResult: r.value });
                    }
                  }}
                  disabled={actionLoading}
                >
                  <Text style={[styles.resultGridText, { color: r.value === "dead" ? "#EF4444" : colors.foreground }]}>{r.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={() => setActionStep(null)}>
                <Text style={[styles.backLink, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {actionStep === "vm_done" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.stepHeader}>
                <Feather name="voicemail" size={20} color="#F97316" />
                <Text style={[styles.stepTitle, { color: "#F97316" }]}>VOICEMAIL DROP</Text>
              </View>
              <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>What happened?</Text>
              {VM_RESULTS.map(r => (
                <TouchableOpacity
                  key={r.value}
                  style={[styles.resultGridItem, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                  onPress={() => {
                    if (r.value === "spoke_with_customer") {
                      setActionStep("spoke_result");
                    } else {
                      logAction({ actionType: "voicemail_drop", vmResult: r.value });
                    }
                  }}
                  disabled={actionLoading}
                >
                  <Text style={[styles.resultGridText, { color: colors.foreground }]}>{r.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={() => setActionStep(null)}>
                <Text style={[styles.backLink, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          <ScrollView
            ref={detailTabScrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.tabScroll, { borderBottomColor: colors.border }]}
            contentContainerStyle={styles.tabScrollContent}
            onLayout={handleDetailScrollViewLayout}
          >
            {DETAIL_TABS.map(tab => {
              const isActive = activeTab === tab.key;
              return (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.detailTab, isActive && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
                  onLayout={(e) => handleDetailTabLayout(tab.key, e)}
                  onPress={() => {
                    setActiveTab(tab.key);
                    scrollDetailTabIntoView(tab.key);
                    if (Platform.OS !== "web") Haptics.selectionAsync();
                  }}
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

          {activeTab === "actions" && !isTerminal && actionStep === null && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
                Tap CALL, TEXT, or VM above to log an action
              </Text>
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
              {historyError ? (
                <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={styles.emptyMessages}>
                    <Feather name="alert-circle" size={32} color={colors.destructive} />
                    <Text style={[styles.emptyMsgText, { color: colors.destructive }]}>{historyError}</Text>
                  </View>
                </View>
              ) : history.length === 0 ? (
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
  transferBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  flagsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  flagBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5 },
  flagText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  blockedWarning: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  blockedWarningText: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#EF4444", flex: 1 },
  contactActions: { flexDirection: "row", gap: 10 },
  contactBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 10 },
  contactBtnText: { fontSize: 14, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  callbackBanner: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  callbackBannerText: { fontSize: 12, fontFamily: "Inter_500Medium", color: "#F59E0B" },
  detailRows: { gap: 8 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  detailText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  transferCard: { marginHorizontal: 16, marginTop: 8, padding: 16, borderRadius: 14, borderWidth: 1, gap: 10 },
  transferTitle: { fontSize: 13, fontFamily: "Inter_500Medium" },
  transferList: { gap: 6 },
  transferItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  transferItemText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  transferScrollList: { maxHeight: 300 },
  transferItemRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  transferAvatar: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  transferAvatarText: { fontSize: 14, fontFamily: "Inter_700Bold" },
  transferConfirmBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  transferConfirmText: { fontSize: 14, fontFamily: "Inter_700Bold", color: "#FFF" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 20, paddingBottom: 36, paddingTop: 12, gap: 12 },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: "#888", alignSelf: "center", marginBottom: 4 },
  modalTitle: { fontSize: 18, fontFamily: "Inter_700Bold" },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  modalCancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center", borderWidth: 1 },
  modalCancelText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  datePickerBtn: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1 },
  datePickerText: { fontSize: 15, fontFamily: "Inter_500Medium" },
  feedbackBar: { marginHorizontal: 16, marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  feedbackText: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1 },
  actionCard: { marginHorizontal: 16, marginTop: 8, marginBottom: 12, padding: 16, borderRadius: 14, borderWidth: 1, gap: 12 },
  stepHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepTitle: { fontSize: 14, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  stepSubtitle: { fontSize: 14, fontFamily: "Inter_400Regular" },
  outcomeBtn: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1 },
  outcomeBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  resultGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  resultGridItem: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1 },
  resultGridText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  cancelInput: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 14, fontFamily: "Inter_400Regular", minHeight: 80, textAlignVertical: "top" },
  backLink: { fontSize: 12, fontFamily: "Inter_500Medium", textAlign: "center", paddingTop: 4 },
  sectionTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
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
  messageBubble: { padding: 10, borderRadius: 12, gap: 4 },
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
