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
import { EditableSourcePicker } from "@/components/EditableSourcePicker";

type ActionStep =
  | null
  | "call_done"
  | "spoke_result"
  | "call_callback"
  | "dead_reason"
  | "text_done"
  | "vm_done"
  | "appt_booked_spoke"
  | "appt_cancel_reason"
  | "dead_reason_custom";

type DetailTab = "history";

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
  { value: "custom", label: "Custom Note" },
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
  originalSource?: string;
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
  deadReason?: string;
  hasSoldEstimate?: boolean;
  resubmittedAt?: string | null;
  resubmissionCount?: number | null;
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

interface TimelineEntry {
  type: "pulse_action" | "podium_text" | "podium_call";
  source: string;
  timestamp: string;
  id: number;
  actionType?: string;
  method?: string;
  callResult?: string;
  textResult?: string;
  vmResult?: string;
  deadReason?: string;
  spokeResult?: string;
  callbackAt?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  outcome?: string;
  notes?: string;
  csrName?: string;
  userId?: number;
  direction?: string;
  body?: string;
  channelType?: string;
  senderName?: string;
  deliveryStatus?: string;
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === "1") return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return phone;
}

interface CorrectionRecord {
  id: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
  changedByName: string | null;
}

function CorrectionHistory({ leadId, tenantQs }: { leadId: number; tenantQs: string }) {
  const colors = useColors();
  const { apiFetch } = useApi();
  const [corrections, setCorrections] = useState<CorrectionRecord[]>([]);

  useEffect(() => {
    apiFetch(`/api/leads-hub/${leadId}/corrections${tenantQs}`)
      .then((d: { corrections?: CorrectionRecord[] }) => setCorrections(d.corrections || []))
      .catch(() => {});
  }, [leadId, tenantQs, apiFetch]);

  if (corrections.length === 0) return null;

  return (
    <View style={{ marginTop: 12, padding: 10, borderRadius: 10, backgroundColor: colors.secondary, borderWidth: 1, borderColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <Feather name="clock" size={12} color={colors.mutedForeground} />
        <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_700Bold", letterSpacing: 1 }}>CORRECTION HISTORY</Text>
      </View>
      {corrections.map(c => (
        <View key={c.id} style={{ marginBottom: 4 }}>
          <Text style={{ fontSize: 11, color: colors.foreground, fontFamily: "Inter_500Medium" }}>
            <Text style={{ color: colors.mutedForeground, textTransform: "uppercase" }}>{c.field}</Text>
            {"  "}
            <Text style={{ color: colors.mutedForeground, textDecorationLine: "line-through" }}>{c.oldValue || "—"}</Text>
            {"  →  "}
            <Text style={{ color: colors.foreground }}>{c.newValue || "—"}</Text>
          </Text>
          <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
            {new Date(c.changedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            {c.changedByName ? ` · by ${c.changedByName}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ContractBanner({ leadId }: { leadId: number }) {
  const colors = useColors();
  const { apiFetch } = useApi();
  const [estimates, setEstimates] = useState<Array<{
    id: number;
    soldByName: string | null;
    soldOn: string | null;
    totalAmount: number;
    subtotal: number;
    rebateAmount: number;
  }>>([]);

  useEffect(() => {
    apiFetch(`/leads-hub/${leadId}/contract`)
      .then((d: { estimates?: typeof estimates }) => setEstimates(d.estimates || []))
      .catch(() => {});
  }, [leadId, apiFetch]);

  if (estimates.length === 0) return null;

  return (
    <View style={{ marginTop: 12 }}>
      {estimates.map(est => (
        <View key={est.id} style={{ backgroundColor: "#F59E0B10", borderWidth: 1, borderColor: "#F59E0B25", borderRadius: 10, padding: 12, marginBottom: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <Feather name="check-circle" size={14} color="#F59E0B" />
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#F59E0B" }}>Signed Contract</Text>
          </View>
          <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#F59E0B", marginBottom: 4 }}>
            ${(est.totalAmount || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Text>
          {est.soldByName && (
            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: colors.mutedForeground }}>
              Sold by: {est.soldByName}
            </Text>
          )}
          {est.soldOn && (
            <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: colors.mutedForeground, marginTop: 2 }}>
              {new Date(est.soldOn).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
            </Text>
          )}
          {est.rebateAmount > 0 && (
            <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#10B981", marginTop: 2 }}>
              Rebate: ${est.rebateAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

export default function LeadDetailScreen() {
  const params = useLocalSearchParams<{ id: string; lead?: string; focusSms?: string }>();
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
  const [activeTab, setActiveTab] = useState<DetailTab>("history");
  const [newMessage, setNewMessage] = useState("");
  const [sendingMsg, setSendingMsg] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [conversationUid, setConversationUid] = useState<string | null>(null);
  const [unifiedTimeline, setUnifiedTimeline] = useState<TimelineEntry[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [expandedCallIds, setExpandedCallIds] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ actionType: "", notes: "", callResult: "", textResult: "", vmResult: "", deadReason: "", spokeResult: "", apptBookedOutcome: "", editCallbackDate: new Date(Date.now() + 3600000), editApptDate: new Date(Date.now() + 86400000), editApptTime: new Date(Date.now() + 86400000) });
  const [showEditDatePicker, setShowEditDatePicker] = useState(false);
  const [showEditTimePicker, setShowEditTimePicker] = useState(false);
  const [showEditApptDatePicker, setShowEditApptDatePicker] = useState(false);
  const [showEditApptTimePicker, setShowEditApptTimePicker] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [commConfig, setCommConfig] = useState<{ textPlatform: string }>({ textPlatform: "native" });
  const [podiumExpanded, setPodiumExpanded] = useState(false);

  const [actionStep, setActionStep] = useState<ActionStep>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [deadFromFlow, setDeadFromFlow] = useState<"call" | "text">("call");
  const [apptBookedChannel, setApptBookedChannel] = useState<"call" | "text" | "voicemail_drop">("call");
  const [callbackDate, setCallbackDate] = useState<Date>(new Date(Date.now() + 3600000));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [customDeadNote, setCustomDeadNote] = useState("");
  const [editCustomDeadNote, setEditCustomDeadNote] = useState("");

  const [showTransfer, setShowTransfer] = useState(false);
  const [csrs, setCsrs] = useState<CsrOption[]>([]);
  const [selectedCsr, setSelectedCsr] = useState<number | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const claimedLeadId = useRef<number | null>(null);

  const mainScrollRef = useRef<ScrollView>(null);
  const podiumSectionY = useRef<number>(0);
  const smsInputRef = useRef<TextInput>(null);
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

  const fetchTimeline = useCallback(async () => {
    try {
      setTimelineLoading(true);
      const data = await apiFetch(`/api/podium/timeline/${params.id}${tenantQs}`);
      setUnifiedTimeline(data.timeline || []);
    } catch {
      setUnifiedTimeline([]);
    } finally {
      setTimelineLoading(false);
    }
  }, [apiFetch, params.id, tenantQs]);

  const fetchMessages = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/podium/conversations/${params.id}${tenantQs}`);
      setMessages(data.messages || []);
      if (data.conversationUid) setConversationUid(data.conversationUid);
    } catch {}
  }, [apiFetch, params.id, tenantQs]);

  const fetchCommConfig = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/leads/comm-config${tenantQs}`);
      setCommConfig({ textPlatform: data.textPlatform || "native" });
    } catch {}
  }, [apiFetch, tenantQs]);

  useEffect(() => {
    const init = async () => {
      const hasLead = lead ? true : await fetchLead();
      if (hasLead) {
        fetchHistory();
        fetchTimeline();
      }
      fetchMessages();
      fetchCommConfig();
    };
    init();
  }, []);

  const focusSmsConsumed = useRef(false);
  useEffect(() => {
    if (params.focusSms !== "1" || focusSmsConsumed.current) return;
    if (!lead) return;

    focusSmsConsumed.current = true;
    setPodiumExpanded(true);

    let attempts = 0;
    const maxAttempts = 15;
    const tryScrollAndFocus = () => {
      attempts++;
      if (mainScrollRef.current && podiumSectionY.current > 0) {
        mainScrollRef.current.scrollTo({ y: podiumSectionY.current, animated: true });
      }
      if (smsInputRef.current) {
        smsInputRef.current.focus();
      } else if (attempts < maxAttempts) {
        setTimeout(tryScrollAndFocus, 200);
      }
    };
    setTimeout(tryScrollAndFocus, 300);
  }, [params.focusSms, lead]);

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
        fetchTimeline();
      }
    };
    on("podium-message", handler);
    return () => off("podium-message", handler);
  }, [on, off, params.id, fetchMessages, fetchTimeline]);

  useEffect(() => {
    const handler = (data: { id?: number; leadId?: number }) => {
      const updatedId = Number(data?.id ?? data?.leadId);
      if (updatedId === Number(params.id)) {
        fetchLead();
        fetchHistory();
        fetchTimeline();
      }
    };
    on("lead-updated", handler);
    return () => off("lead-updated", handler);
  }, [on, off, params.id, fetchLead, fetchHistory, fetchTimeline]);

  useEffect(() => {
    return () => {
      const lid = claimedLeadId.current;
      if (lid) {
        apiFetch(`/api/leads-hub/${lid}/release-claim${tenantQs}`, { method: "POST" }).catch(() => {});
        claimedLeadId.current = null;
      }
    };
  }, []);

  const tryClaimLead = async (): Promise<boolean> => {
    const lid = Number(params.id);
    try {
      await apiFetch(`/api/leads-hub/${lid}/claim${tenantQs}`, { method: "POST" });
      claimedLeadId.current = lid;
      return true;
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Could not claim this lead — it may have been reassigned");
      return false;
    }
  };

  const logAction = async (body: Record<string, unknown>) => {
    setActionLoading(true);
    try {
      const res = await apiFetch("/api/leads-hub/action" + tenantQs, {
        method: "POST",
        body: JSON.stringify({ leadId: Number(params.id), ...body }),
      });
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showFeedback("success", `Action logged — ${res.lead?.hubStatus || "updated"}`);
      claimedLeadId.current = null;
      setActionStep(null);
      setCallbackDate(new Date(Date.now() + 3600000));
      setCancelReason("");
      fetchLead();
      fetchHistory();
      fetchTimeline();
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to log action");
    } finally {
      setActionLoading(false);
    }
  };

  const handleCall = async () => {
    if (blocksCall) {
      showFeedback("error", "This lead has a contact restriction that prevents calls");
      return;
    }
    const claimed = await tryClaimLead();
    if (!claimed) return;
    if (lead?.phone) {
      const telUrl = `tel:${lead.phone.replace(/\D/g, "")}`;
      try {
        const canOpen = await Linking.canOpenURL(telUrl);
        if (canOpen) {
          await Linking.openURL(telUrl);
        } else {
          showFeedback("error", "Phone calls are not supported on this device");
        }
      } catch {
        showFeedback("error", "Could not open the phone dialer");
      }
    }
    if (lead?.hubStatus === "appt_booked") {
      setApptBookedChannel("call");
    }
    setActionStep("call_done");
  };

  const handleText = async () => {
    const claimed = await tryClaimLead();
    if (!claimed) return;
    if (lead?.phone && commConfig.textPlatform !== "podium") {
      try {
        const smsUrl = `sms:${lead.phone.replace(/\D/g, "")}`;
        const canOpen = await Linking.canOpenURL(smsUrl);
        if (canOpen) await Linking.openURL(smsUrl);
      } catch {}
    }
    if (lead?.hubStatus === "appt_booked") {
      setApptBookedChannel("text");
    }
    setActionStep("text_done");
  };

  const handleVmDrop = async () => {
    if (blocksCall) {
      showFeedback("error", "This lead has a contact restriction that prevents calls");
      return;
    }
    const claimed = await tryClaimLead();
    if (!claimed) return;
    if (lead?.hubStatus === "appt_booked") {
      setApptBookedChannel("voicemail_drop");
    }
    setActionStep("vm_done");
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
        body: JSON.stringify({ leadId: Number(params.id), body: newMessage.trim() }),
      });
      setNewMessage("");
      fetchMessages();
      fetchTimeline();
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
            <TouchableOpacity onPress={async () => { const ok = await fetchLead(); if (ok) { fetchHistory(); fetchTimeline(); fetchMessages(); fetchCommConfig(); } else { setTimelineLoading(false); } }} style={{ marginTop: 16, padding: 12, backgroundColor: colors.primary, borderRadius: 8 }}>
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

  const isPodiumConnected = commConfig.textPlatform === "podium";

  const DETAIL_TABS: { key: DetailTab; label: string; icon: keyof typeof Feather.glyphMap; badge?: number }[] = [
    { key: "history", label: "History", icon: "clock" },
  ];

  const toggleCallExpand = (id: number) => {
    setExpandedCallIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const startEdit = (entry: TimelineEntry) => {
    setEditingId(entry.id);
    const dr = entry.deadReason || "";
    const isExistingCustom = dr && !DEAD_REASONS.some(d => d.value === dr && d.value !== "custom");
    setEditCustomDeadNote(isExistingCustom ? dr : "");
    const existingApptOutcome = entry.outcome?.startsWith("appt_") ? entry.outcome.replace("appt_", "") : "";
    setEditForm({
      actionType: entry.actionType || entry.method || "",
      notes: entry.notes || "",
      callResult: entry.callResult || "",
      textResult: entry.textResult || "",
      vmResult: entry.vmResult || "",
      deadReason: isExistingCustom ? "custom" : dr,
      spokeResult: entry.spokeResult || "",
      apptBookedOutcome: existingApptOutcome,
      editCallbackDate: entry.callbackAt ? new Date(entry.callbackAt) : new Date(Date.now() + 3600000),
      editApptDate: entry.appointmentDate ? new Date(entry.appointmentDate) : new Date(Date.now() + 86400000),
      editApptTime: entry.appointmentTime ? (() => { const [h, m] = entry.appointmentTime!.split(":").map(Number); const d = new Date(); d.setHours(h || 9, m || 0, 0, 0); return d; })() : (() => { const d = new Date(); d.setHours(9, 0, 0, 0); return d; })(),
    });
    setShowEditDatePicker(false);
    setShowEditTimePicker(false);
    setShowEditApptDatePicker(false);
    setShowEditApptTimePicker(false);
  };

  const saveEdit = async (entry: TimelineEntry) => {
    setEditSaving(true);
    try {
      const resolvedDeadReason = (() => {
        if (!editForm.deadReason) return null;
        const isCustomDead = editForm.deadReason === "custom" || !DEAD_REASONS.some(d => d.value === editForm.deadReason && d.value !== "custom");
        if (isCustomDead) return editCustomDeadNote.trim() || (editForm.deadReason !== "custom" ? editForm.deadReason : null);
        return editForm.deadReason;
      })();
      const body: Record<string, unknown> = { notes: editForm.notes, actionType: editForm.actionType, deadReason: resolvedDeadReason };
      const method = editForm.actionType || entry.actionType || entry.method;
      if (method === "call") body.callResult = editForm.callResult || null;
      if (method === "text") body.textResult = editForm.textResult || null;
      if (method === "voicemail" || method === "voicemail_drop") body.vmResult = editForm.vmResult || null;
      if (lead?.hubStatus === "appt_booked") {
        const hasContact = editForm.callResult === "spoke_with_customer" || editForm.textResult === "yes" || editForm.vmResult === "spoke_with_customer";
        if (hasContact && !editForm.apptBookedOutcome) {
          Alert.alert("Missing Info", "Please select an appointment status (Confirmed, Rescheduled, or Canceled).");
          setEditSaving(false);
          return;
        }
        if (editForm.apptBookedOutcome) body.apptBookedOutcome = editForm.apptBookedOutcome;
      }
      if (editForm.callResult === "spoke_with_customer" && lead?.hubStatus !== "appt_booked") {
        if (!editForm.spokeResult) {
          Alert.alert("Missing Info", "Please select a spoke result (Appointment Set, Callback Requested, or Dead Lead).");
          setEditSaving(false);
          return;
        }
        body.spokeResult = editForm.spokeResult;
        body.callbackAt = null;
        body.appointmentSet = null;
        if (editForm.spokeResult === "call_back") {
          if (editForm.editCallbackDate.getTime() <= Date.now()) {
            Alert.alert("Invalid Date", "Please select a future callback date/time.");
            setEditSaving(false);
            return;
          }
          body.callbackAt = editForm.editCallbackDate.toISOString();
        } else if (editForm.spokeResult === "appointment_set") {
          body.appointmentSet = true;
          body.appointmentDate = editForm.editApptDate.toISOString().split("T")[0];
          body.appointmentTime = editForm.editApptTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
        } else if (editForm.spokeResult === "dead") {
          const isCustomDead = editForm.deadReason === "custom" || (editForm.deadReason && !DEAD_REASONS.some(d => d.value === editForm.deadReason && d.value !== "custom"));
          if (isCustomDead) {
            const customText = editCustomDeadNote.trim() || (editForm.deadReason !== "custom" ? editForm.deadReason : "");
            if (!customText) {
              Alert.alert("Missing Info", "Please enter a custom dead reason.");
              setEditSaving(false);
              return;
            }
            body.deadReason = customText;
          } else if (!editForm.deadReason) {
            Alert.alert("Missing Info", "Please select a dead reason.");
            setEditSaving(false);
            return;
          } else {
            body.deadReason = editForm.deadReason;
          }
        }
      }

      await apiFetch(`/api/leads-hub/action/${entry.id}${tenantQs}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setEditingId(null);
      fetchTimeline();
      fetchHistory();
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Save failed");
    } finally {
      setEditSaving(false);
    }
  };

  const getTimelineIcon = (entry: TimelineEntry): { name: keyof typeof Feather.glyphMap; color: string } => {
    if (entry.type === "podium_text") return { name: "message-square", color: "#3B82F6" };
    if (entry.type === "podium_call") return { name: "phone", color: "#06B6D4" };
    if (entry.outcome === "resubmission") return { name: "refresh-cw", color: "#06B6D4" };
    if (entry.actionType === "call" || entry.method === "call") return { name: "phone", color: colors.foreground };
    if (entry.actionType === "text" || entry.method === "text") return { name: "message-square", color: colors.foreground };
    if (entry.actionType === "voicemail_drop" || entry.method === "voicemail") return { name: "voicemail", color: colors.foreground };
    if (entry.method === "transfer") return { name: "user-plus", color: colors.foreground };
    return { name: "clock", color: colors.foreground };
  };

  const getOutcomeLabel = (entry: TimelineEntry) => {
    if (entry.outcome === "resubmission") return "Resubmitted Lead";
    const result = entry.callResult || entry.textResult || entry.vmResult || entry.outcome;
    return ((result as string) || "").replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
  };

  const canEditEntry = (entry: TimelineEntry) => {
    if (entry.source !== "pulse") return false;
    const isAdminRole = ["client_admin", "agency_user", "super_admin"].includes(user?.role || "");
    return isAdminRole || entry.userId === user?.id;
  };

  const EDIT_ACTION_TYPES = [
    { value: "call", label: "Call" },
    { value: "text", label: "Text" },
    { value: "voicemail_drop", label: "VM Drop" },
  ];

  const getEditOutcomeOptions = () => {
    const m = editForm.actionType;
    if (m === "call") return CALL_RESULTS;
    if (m === "text") return TEXT_RESULTS;
    if (m === "voicemail" || m === "voicemail_drop") return VM_RESULTS;
    return [];
  };

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
          ref={mainScrollRef}
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
                  {lead.hasSoldEstimate && (
                    <View style={[styles.dayBadge, { backgroundColor: "#F59E0B20", borderColor: "#F59E0B30" }]}>
                      <Text style={[styles.dayBadgeText, { color: "#F59E0B" }]}>CLOSED</Text>
                    </View>
                  )}
                  {lead.resubmittedAt && (
                    <View style={[styles.dayBadge, { backgroundColor: "#06B6D420", borderColor: "#06B6D440" }]}>
                      <Text style={[styles.dayBadgeText, { color: "#06B6D4" }]}>
                        {lead.resubmissionCount && lead.resubmissionCount > 0 ? `RESUB ×${lead.resubmissionCount}` : "RESUB"}
                      </Text>
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
              {(lead.source || effectiveTenantId) && (
                <View style={styles.detailRow}>
                  <Feather name="target" size={14} color={colors.mutedForeground} />
                  <EditableSourcePicker
                    leadId={lead.id}
                    source={lead.source || "Unknown"}
                    originalSource={lead.originalSource}
                    userRole={user?.role}
                    tenantId={effectiveTenantId}
                    onSourceChanged={(newSource) => setLead(prev => prev ? { ...prev, source: newSource } : prev)}
                  />
                </View>
              )}
              {lead.leadType && (
                <View style={styles.detailRow}>
                  <Feather name="filter" size={14} color="#8B5CF6" />
                  <Text style={[styles.detailText, { color: colors.foreground }]}>{lead.leadType}</Text>
                </View>
              )}
              {lead.interestType && (
                <View style={styles.detailRow}>
                  <Feather name="tag" size={14} color={colors.mutedForeground} />
                  <Text style={[styles.detailText, { color: colors.foreground }]}>{lead.interestType}</Text>
                </View>
              )}
              {lead.deadReason && (
                <View style={styles.detailRow}>
                  <Feather name="x-circle" size={14} color="#EF4444" />
                  <Text style={[styles.detailText, { color: "#EF4444", opacity: 0.7 }]}>Reason: {lead.deadReason.replace(/_/g, " ")}</Text>
                </View>
              )}
            </View>

            {lead.hasSoldEstimate && (
              <ContractBanner leadId={lead.id} />
            )}

            <CorrectionHistory leadId={lead.id} tenantQs={tenantQs} />
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

          {actionStep === "appt_booked_spoke" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.stepHeader}>
                <Feather name="calendar" size={20} color="#8B5CF6" />
                <Text style={[styles.stepTitle, { color: "#8B5CF6" }]}>PRE-BOOKED APPOINTMENT</Text>
              </View>
              <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>Spoke with customer — confirm the appointment status:</Text>
              <TouchableOpacity
                style={[styles.outcomeBtn, { backgroundColor: "#10B98115", borderColor: "#10B98125" }]}
                onPress={() => logAction({
                  actionType: apptBookedChannel,
                  apptBookedOutcome: "confirmed",
                  ...(apptBookedChannel === "call" ? { callResult: "spoke_with_customer" } : {}),
                  ...(apptBookedChannel === "text" ? { textResult: "yes" } : {}),
                  ...(apptBookedChannel === "voicemail_drop" ? { vmResult: "spoke_with_customer" } : {}),
                })}
                disabled={actionLoading}
              >
                {actionLoading ? <ActivityIndicator size="small" color="#10B981" /> : <Feather name="check-circle" size={16} color="#10B981" />}
                <Text style={[styles.outcomeBtnText, { color: "#10B981" }]}>Confirmed</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.outcomeBtn, { backgroundColor: "#F59E0B15", borderColor: "#F59E0B25" }]}
                onPress={() => logAction({
                  actionType: apptBookedChannel,
                  apptBookedOutcome: "rescheduled",
                  ...(apptBookedChannel === "call" ? { callResult: "spoke_with_customer" } : {}),
                  ...(apptBookedChannel === "text" ? { textResult: "yes" } : {}),
                  ...(apptBookedChannel === "voicemail_drop" ? { vmResult: "spoke_with_customer" } : {}),
                })}
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
              <TouchableOpacity onPress={() => setActionStep(apptBookedChannel === "call" ? "call_done" : apptBookedChannel === "text" ? "text_done" : "vm_done")}>
                <Text style={[styles.backLink, { color: colors.mutedForeground }]}>Back</Text>
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
                onPress={() => logAction({
                  actionType: apptBookedChannel,
                  apptBookedOutcome: "canceled",
                  cancelReason: cancelReason || "appointment_canceled",
                  ...(apptBookedChannel === "call" ? { callResult: "spoke_with_customer" } : {}),
                  ...(apptBookedChannel === "text" ? { textResult: "yes" } : {}),
                  ...(apptBookedChannel === "voicemail_drop" ? { vmResult: "spoke_with_customer" } : {}),
                })}
                disabled={actionLoading}
              >
                {actionLoading ? <ActivityIndicator size="small" color="#EF4444" /> : <Text style={[styles.outcomeBtnText, { color: "#EF4444" }]}>Confirm Cancellation</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setActionStep("appt_booked_spoke")}>
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
                        if (lead?.hubStatus === "appt_booked") {
                          setActionStep("appt_booked_spoke");
                        } else {
                          setActionStep("spoke_result");
                        }
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
                  onChange={(_: unknown, date?: Date) => {
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
                  onChange={(_: unknown, date?: Date) => {
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
                    if (r.value === "custom") {
                      setCustomDeadNote("");
                      setActionStep("dead_reason_custom");
                      return;
                    }
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

          {actionStep === "dead_reason_custom" && (
            <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>
                Enter custom dead reason:
              </Text>
              <TextInput
                style={{ backgroundColor: colors.background, color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14, fontFamily: "Inter_400Regular", minHeight: 60, textAlignVertical: "top", marginBottom: 8 }}
                placeholder="Type your reason..."
                placeholderTextColor={colors.mutedForeground}
                value={customDeadNote}
                onChangeText={setCustomDeadNote}
                multiline
                autoFocus
              />
              <TouchableOpacity
                style={[styles.resultGridItem, { backgroundColor: customDeadNote.trim() ? "#EF444420" : "#EF444410", borderColor: "#EF444420", opacity: customDeadNote.trim() ? 1 : 0.5 }]}
                onPress={() => {
                  if (!customDeadNote.trim()) return;
                  if (deadFromFlow === "call") {
                    logAction({ actionType: "call", callResult: "spoke_with_customer", deadReason: customDeadNote.trim() });
                  } else {
                    logAction({ actionType: "text", textResult: "dead", deadReason: customDeadNote.trim() });
                  }
                }}
                disabled={actionLoading || !customDeadNote.trim()}
              >
                <Text style={[styles.resultGridText, { color: "#EF4444" }]}>Submit</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setActionStep("dead_reason")}>
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
                    } else if (r.value === "yes" && lead?.hubStatus === "appt_booked") {
                      setApptBookedChannel("text");
                      setActionStep("appt_booked_spoke");
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
                      if (lead?.hubStatus === "appt_booked") {
                        setApptBookedChannel("voicemail_drop");
                        setActionStep("appt_booked_spoke");
                      } else {
                        setActionStep("spoke_result");
                      }
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

          {activeTab === "history" && (
            <View style={styles.historyContainer}>
              {timelineLoading ? (
                <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 20 }} />
              ) : unifiedTimeline.length === 0 ? (
                <View style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={styles.emptyMessages}>
                    <Feather name="clock" size={32} color={colors.mutedForeground} />
                    <Text style={[styles.emptyMsgText, { color: colors.mutedForeground }]}>No actions logged yet</Text>
                  </View>
                </View>
              ) : (
                <>
                  <View style={styles.timelineLine}>
                    {(timelineExpanded ? unifiedTimeline : unifiedTimeline.slice(0, 5)).map(entry => {
                      const icon = getTimelineIcon(entry);
                      const nodeColor = entry.source === "podium" ? "#3B82F620" : colors.card;
                      const nodeBorder = entry.source === "podium" ? "#3B82F630" : colors.border;
                      const isEditing = editingId === entry.id;

                      return (
                        <View key={`${entry.source}-${entry.id}`} style={styles.timelineRow}>
                          <View style={styles.timelineNodeCol}>
                            <View style={[styles.timelineNode, { backgroundColor: nodeColor, borderColor: nodeBorder }]}>
                              <Feather name={icon.name} size={10} color={icon.color} />
                            </View>
                            <View style={[styles.timelineConnector, { backgroundColor: colors.border }]} />
                          </View>

                          <View style={styles.timelineContent}>
                            {entry.source === "podium" && entry.type === "podium_text" && (
                              <View style={[
                                styles.messageBubble,
                                entry.direction === "outbound"
                                  ? { backgroundColor: "#3B82F615", borderColor: "#3B82F620", borderWidth: 1 }
                                  : { backgroundColor: colors.secondary, borderColor: colors.border, borderWidth: 1 },
                              ]}>
                                <Text style={[styles.msgBody, { color: colors.foreground }]}>{entry.body || ""}</Text>
                                <View style={styles.podiumMeta}>
                                  <Text style={[styles.msgTime, { color: colors.mutedForeground }]}>
                                    {new Date(entry.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                                  </Text>
                                  <View style={[styles.podiumBadge, { backgroundColor: "#3B82F615" }]}>
                                    <Text style={{ fontSize: 9, color: "#3B82F6", fontFamily: "Inter_600SemiBold" }}>{entry.channelType === "form" ? "Podium Form" : "Podium SMS"}</Text>
                                  </View>
                                  {entry.channelType === "form" ? (
                                    <Text style={{ fontSize: 9, color: "#F59E0B80", fontFamily: "Inter_400Regular", fontStyle: "italic" }}>Only visible in Podium</Text>
                                  ) : (
                                    <Text style={{ fontSize: 9, color: entry.direction === "outbound" ? "#3B82F680" : "#10B98180", fontFamily: "Inter_400Regular" }}>
                                      {entry.direction === "outbound" ? "Sent" : "Received"}
                                    </Text>
                                  )}
                                  {entry.deliveryStatus === "failed" && (
                                    <Text style={{ fontSize: 9, color: "#EF4444", fontFamily: "Inter_600SemiBold" }}>Failed</Text>
                                  )}
                                </View>
                              </View>
                            )}

                            {entry.source === "podium" && entry.type === "podium_call" && (
                              <View>
                                <TouchableOpacity
                                  style={[styles.podiumCallBtn, { backgroundColor: "#06B6D408", borderColor: "#06B6D420" }]}
                                  onPress={() => toggleCallExpand(entry.id)}
                                  activeOpacity={0.7}
                                >
                                  <View style={styles.podiumCallRow}>
                                    <Feather name="phone" size={12} color="#06B6D4" />
                                    <Text style={{ fontSize: 13, color: "#67E8F9", fontFamily: "Inter_600SemiBold", flex: 1 }}>
                                      {entry.direction === "inbound" ? "Incoming Call" : "Outgoing Call"}
                                    </Text>
                                    {entry.senderName && <Text style={{ fontSize: 11, color: colors.mutedForeground }}>— {entry.senderName}</Text>}
                                    <Feather name="chevron-down" size={14} color="#06B6D480" style={expandedCallIds.has(entry.id) ? { transform: [{ rotate: "180deg" }] } : {}} />
                                  </View>
                                  <View style={styles.podiumMeta}>
                                    <Text style={[styles.msgTime, { color: colors.mutedForeground }]}>
                                      {new Date(entry.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                                    </Text>
                                    <View style={[styles.podiumBadge, { backgroundColor: "#06B6D415" }]}>
                                      <Text style={{ fontSize: 9, color: "#06B6D4", fontFamily: "Inter_600SemiBold" }}>Podium Call</Text>
                                    </View>
                                  </View>
                                </TouchableOpacity>
                                {expandedCallIds.has(entry.id) && entry.body && (
                                  <View style={[styles.transcriptBlock, { borderLeftColor: "#06B6D420" }]}>
                                    <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_700Bold", letterSpacing: 1, marginBottom: 4 }}>TRANSCRIPT / NOTES</Text>
                                    <Text style={{ fontSize: 12, color: colors.foreground, fontFamily: "Inter_400Regular", lineHeight: 18 }}>{entry.body}</Text>
                                  </View>
                                )}
                              </View>
                            )}

                            {entry.source === "pulse" && !isEditing && (
                              <View style={styles.pulseEntry}>
                                <View style={styles.pulseEntryHeader}>
                                  <Text style={[styles.msgTime, { color: colors.mutedForeground }]}>
                                    {new Date(entry.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                                  </Text>
                                  {entry.csrName && <Text style={{ fontSize: 11, color: colors.mutedForeground + "80", fontFamily: "Inter_400Regular" }}>{entry.csrName}</Text>}
                                  <Text style={{ fontSize: 11, color: colors.foreground + "99", fontFamily: "Inter_600SemiBold" }}>{getOutcomeLabel(entry)}</Text>
                                  {canEditEntry(entry) && (
                                    <TouchableOpacity onPress={() => startEdit(entry)} style={styles.editBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                      <Feather name="edit-2" size={12} color={colors.mutedForeground} />
                                    </TouchableOpacity>
                                  )}
                                </View>
                                {entry.deadReason && <Text style={{ fontSize: 11, color: "#EF4444", fontFamily: "Inter_400Regular", opacity: 0.7, marginTop: 2 }}>Reason: {entry.deadReason.replace(/_/g, " ")}</Text>}
                                {entry.notes && <Text style={[styles.historyNotes, { color: colors.foreground + "60" }]}>{entry.notes}</Text>}
                              </View>
                            )}

                            {entry.source === "pulse" && isEditing && (
                              <View style={[styles.editCard, { backgroundColor: colors.card, borderColor: "#F59E0B40" }]}>
                                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 }}>
                                  <Text style={[styles.msgTime, { color: colors.mutedForeground }]}>
                                    {new Date(entry.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                                  </Text>
                                  <Text style={{ fontSize: 11, color: "#F59E0B", fontFamily: "Inter_600SemiBold" }}>Editing</Text>
                                </View>
                                <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold", marginBottom: 4 }}>Action Type</Text>
                                <View style={styles.editPickerRow}>
                                  {EDIT_ACTION_TYPES.map(at => (
                                    <TouchableOpacity
                                      key={at.value}
                                      style={[styles.editPickerItem, {
                                        backgroundColor: editForm.actionType === at.value ? colors.primary + "20" : colors.secondary,
                                        borderColor: editForm.actionType === at.value ? colors.primary + "40" : colors.border,
                                      }]}
                                      onPress={() => setEditForm(f => ({ ...f, actionType: at.value, callResult: "", textResult: "", vmResult: "", spokeResult: "", deadReason: "", apptBookedOutcome: "" }))}
                                    >
                                      <Text style={{ fontSize: 12, color: editForm.actionType === at.value ? colors.primary : colors.foreground, fontFamily: "Inter_500Medium" }}>{at.label}</Text>
                                    </TouchableOpacity>
                                  ))}
                                </View>
                                {getEditOutcomeOptions().length > 0 && (
                                  <>
                                    <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold", marginBottom: 4, marginTop: 8 }}>Outcome</Text>
                                    <View style={styles.editPickerRow}>
                                      {getEditOutcomeOptions().map(opt => {
                                        const val = editForm.actionType === "call" ? editForm.callResult : editForm.actionType === "text" ? editForm.textResult : editForm.vmResult;
                                        return (
                                          <TouchableOpacity
                                            key={opt.value}
                                            style={[styles.editPickerItem, {
                                              backgroundColor: val === opt.value ? colors.primary + "20" : colors.secondary,
                                              borderColor: val === opt.value ? colors.primary + "40" : colors.border,
                                            }]}
                                            onPress={() => {
                                              const m = editForm.actionType;
                                              const isContact = (m === "call" && opt.value === "spoke_with_customer") || (m === "text" && opt.value === "yes") || ((m === "voicemail" || m === "voicemail_drop") && opt.value === "spoke_with_customer");
                                              if (m === "call") setEditForm(f => ({ ...f, callResult: opt.value, spokeResult: opt.value !== "spoke_with_customer" ? "" : f.spokeResult, deadReason: opt.value !== "spoke_with_customer" ? "" : f.deadReason, apptBookedOutcome: isContact ? f.apptBookedOutcome : "" }));
                                              else if (m === "text") setEditForm(f => ({ ...f, textResult: opt.value, apptBookedOutcome: isContact ? f.apptBookedOutcome : "" }));
                                              else setEditForm(f => ({ ...f, vmResult: opt.value, apptBookedOutcome: isContact ? f.apptBookedOutcome : "" }));
                                            }}
                                          >
                                            <Text style={{ fontSize: 12, color: val === opt.value ? colors.primary : colors.foreground, fontFamily: "Inter_500Medium" }}>{opt.label}</Text>
                                          </TouchableOpacity>
                                        );
                                      })}
                                    </View>
                                  </>
                                )}
                                {editForm.callResult === "spoke_with_customer" && lead?.hubStatus !== "appt_booked" && (
                                  <>
                                    <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold", marginBottom: 4, marginTop: 8 }}>Spoke Result</Text>
                                    <View style={styles.editPickerRow}>
                                      {SPOKE_RESULTS.map(sr => (
                                        <TouchableOpacity
                                          key={sr.value}
                                          style={[styles.editPickerItem, {
                                            backgroundColor: editForm.spokeResult === sr.value ? sr.color + "20" : colors.secondary,
                                            borderColor: editForm.spokeResult === sr.value ? sr.color + "40" : colors.border,
                                          }]}
                                          onPress={() => setEditForm(f => ({ ...f, spokeResult: sr.value, deadReason: sr.value !== "dead" ? "" : f.deadReason }))}
                                        >
                                          <Text style={{ fontSize: 12, color: editForm.spokeResult === sr.value ? sr.color : colors.foreground, fontFamily: "Inter_500Medium" }}>{sr.label}</Text>
                                        </TouchableOpacity>
                                      ))}
                                    </View>
                                  </>
                                )}
                                {lead?.hubStatus === "appt_booked" && (editForm.callResult === "spoke_with_customer" || editForm.textResult === "yes" || editForm.vmResult === "spoke_with_customer") && (
                                  <>
                                    <Text style={{ fontSize: 11, color: "#8B5CF6", fontFamily: "Inter_600SemiBold", marginBottom: 4, marginTop: 8 }}>Appointment Status</Text>
                                    <View style={styles.editPickerRow}>
                                      {[
                                        { value: "confirmed", label: "Confirmed", color: "#10B981" },
                                        { value: "rescheduled", label: "Rescheduled", color: "#F59E0B" },
                                        { value: "canceled", label: "Canceled", color: "#EF4444" },
                                      ].map(ao => (
                                        <TouchableOpacity
                                          key={ao.value}
                                          style={[styles.editPickerItem, {
                                            backgroundColor: editForm.apptBookedOutcome === ao.value ? ao.color + "20" : colors.secondary,
                                            borderColor: editForm.apptBookedOutcome === ao.value ? ao.color + "40" : colors.border,
                                          }]}
                                          onPress={() => setEditForm(f => ({ ...f, apptBookedOutcome: f.apptBookedOutcome === ao.value ? "" : ao.value }))}
                                        >
                                          <Text style={{ fontSize: 12, color: editForm.apptBookedOutcome === ao.value ? ao.color : colors.foreground, fontFamily: "Inter_500Medium" }}>{ao.label}</Text>
                                        </TouchableOpacity>
                                      ))}
                                    </View>
                                  </>
                                )}
                                {editForm.callResult === "spoke_with_customer" && editForm.spokeResult === "call_back" && lead?.hubStatus !== "appt_booked" && (
                                  <>
                                    <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold", marginBottom: 4, marginTop: 8 }}>Callback Date & Time</Text>
                                    <TouchableOpacity
                                      style={[styles.editPickerItem, { backgroundColor: colors.secondary, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }]}
                                      onPress={() => setShowEditDatePicker(true)}
                                    >
                                      <Feather name="calendar" size={14} color="#F59E0B" />
                                      <Text style={{ fontSize: 12, color: colors.foreground, fontFamily: "Inter_500Medium" }}>
                                        {editForm.editCallbackDate.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                                      </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      style={[styles.editPickerItem, { backgroundColor: colors.secondary, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 6 }]}
                                      onPress={() => setShowEditTimePicker(true)}
                                    >
                                      <Feather name="clock" size={14} color="#F59E0B" />
                                      <Text style={{ fontSize: 12, color: colors.foreground, fontFamily: "Inter_500Medium" }}>
                                        {editForm.editCallbackDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                                      </Text>
                                    </TouchableOpacity>
                                    {showEditDatePicker && (
                                      <DateTimePicker
                                        value={editForm.editCallbackDate}
                                        mode="date"
                                        minimumDate={new Date()}
                                        onChange={(_: unknown, date?: Date) => {
                                          setShowEditDatePicker(false);
                                          if (date) {
                                            const updated = new Date(editForm.editCallbackDate);
                                            updated.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
                                            setEditForm(f => ({ ...f, editCallbackDate: updated }));
                                          }
                                        }}
                                      />
                                    )}
                                    {showEditTimePicker && (
                                      <DateTimePicker
                                        value={editForm.editCallbackDate}
                                        mode="time"
                                        onChange={(_: unknown, date?: Date) => {
                                          setShowEditTimePicker(false);
                                          if (date) {
                                            const updated = new Date(editForm.editCallbackDate);
                                            updated.setHours(date.getHours(), date.getMinutes());
                                            setEditForm(f => ({ ...f, editCallbackDate: updated }));
                                          }
                                        }}
                                      />
                                    )}
                                  </>
                                )}
                                {editForm.callResult === "spoke_with_customer" && editForm.spokeResult === "appointment_set" && (
                                  <>
                                    <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold", marginBottom: 4, marginTop: 8 }}>Appointment Date & Time</Text>
                                    <TouchableOpacity
                                      style={[styles.editPickerItem, { backgroundColor: colors.secondary, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }]}
                                      onPress={() => setShowEditApptDatePicker(true)}
                                    >
                                      <Feather name="calendar" size={14} color="#10B981" />
                                      <Text style={{ fontSize: 12, color: colors.foreground, fontFamily: "Inter_500Medium" }}>
                                        {editForm.editApptDate.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                                      </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      style={[styles.editPickerItem, { backgroundColor: colors.secondary, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 6 }]}
                                      onPress={() => setShowEditApptTimePicker(true)}
                                    >
                                      <Feather name="clock" size={14} color="#10B981" />
                                      <Text style={{ fontSize: 12, color: colors.foreground, fontFamily: "Inter_500Medium" }}>
                                        {editForm.editApptTime.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                                      </Text>
                                    </TouchableOpacity>
                                    {showEditApptDatePicker && (
                                      <DateTimePicker
                                        value={editForm.editApptDate}
                                        mode="date"
                                        minimumDate={new Date()}
                                        onChange={(_: unknown, date?: Date) => {
                                          setShowEditApptDatePicker(false);
                                          if (date) {
                                            const updated = new Date(editForm.editApptDate);
                                            updated.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
                                            setEditForm(f => ({ ...f, editApptDate: updated }));
                                          }
                                        }}
                                      />
                                    )}
                                    {showEditApptTimePicker && (
                                      <DateTimePicker
                                        value={editForm.editApptTime}
                                        mode="time"
                                        onChange={(_: unknown, date?: Date) => {
                                          setShowEditApptTimePicker(false);
                                          if (date) {
                                            setEditForm(f => ({ ...f, editApptTime: date }));
                                          }
                                        }}
                                      />
                                    )}
                                  </>
                                )}
                                {((editForm.callResult === "spoke_with_customer" && editForm.spokeResult === "dead") || editForm.textResult === "dead") && lead?.hubStatus !== "appt_booked" && (
                                  <>
                                    <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold", marginBottom: 4, marginTop: 8 }}>Dead Reason</Text>
                                    <View style={styles.editPickerRow}>
                                      {DEAD_REASONS.map(dr => {
                                        const isCustomSelected = editForm.deadReason === "custom" || (editForm.deadReason && !DEAD_REASONS.some(d => d.value === editForm.deadReason && d.value !== "custom"));
                                        const isSelected = dr.value === "custom" ? isCustomSelected : editForm.deadReason === dr.value;
                                        return (
                                          <TouchableOpacity
                                            key={dr.value}
                                            style={[styles.editPickerItem, {
                                              backgroundColor: isSelected ? "#EF444420" : colors.secondary,
                                              borderColor: isSelected ? "#EF444440" : colors.border,
                                            }]}
                                            onPress={() => {
                                              if (dr.value === "custom") {
                                                setEditForm(f => ({ ...f, deadReason: "custom" }));
                                                setEditCustomDeadNote("");
                                              } else {
                                                setEditForm(f => ({ ...f, deadReason: dr.value }));
                                                setEditCustomDeadNote("");
                                              }
                                            }}
                                          >
                                            <Text style={{ fontSize: 12, color: isSelected ? "#EF4444" : colors.foreground, fontFamily: "Inter_500Medium" }}>{dr.label}</Text>
                                          </TouchableOpacity>
                                        );
                                      })}
                                    </View>
                                    {(editForm.deadReason === "custom" || (editForm.deadReason && !DEAD_REASONS.some(d => d.value === editForm.deadReason && d.value !== "custom"))) && (
                                      <TextInput
                                        style={{ backgroundColor: colors.background, color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 8, fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 4 }}
                                        placeholder="Type custom reason..."
                                        placeholderTextColor={colors.mutedForeground}
                                        value={editCustomDeadNote || (editForm.deadReason !== "custom" ? editForm.deadReason : "")}
                                        onChangeText={t => { setEditCustomDeadNote(t); }}
                                      />
                                    )}
                                  </>
                                )}
                                <TextInput
                                  style={[styles.editNotesInput, { backgroundColor: colors.background, color: colors.foreground, borderColor: colors.border }]}
                                  placeholder="Notes..."
                                  placeholderTextColor={colors.mutedForeground}
                                  value={editForm.notes}
                                  onChangeText={t => setEditForm(f => ({ ...f, notes: t }))}
                                />
                                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                                  <TouchableOpacity
                                    style={[styles.editSaveBtn, { backgroundColor: "#F59E0B20" }]}
                                    onPress={() => saveEdit(entry)}
                                    disabled={editSaving}
                                  >
                                    {editSaving ? <ActivityIndicator size="small" color="#F59E0B" /> : <Text style={{ fontSize: 12, color: "#F59E0B", fontFamily: "Inter_600SemiBold" }}>Save</Text>}
                                  </TouchableOpacity>
                                  <TouchableOpacity
                                    style={[styles.editCancelBtn, { backgroundColor: colors.secondary }]}
                                    onPress={() => setEditingId(null)}
                                  >
                                    <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold" }}>Cancel</Text>
                                  </TouchableOpacity>
                                </View>
                              </View>
                            )}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                  {unifiedTimeline.length > 5 && !timelineExpanded && (
                    <TouchableOpacity onPress={() => setTimelineExpanded(true)} style={{ paddingLeft: 32, marginTop: 4 }}>
                      <Text style={{ fontSize: 12, color: colors.primary, fontFamily: "Inter_500Medium" }}>
                        Show {unifiedTimeline.length - 5} more...
                      </Text>
                    </TouchableOpacity>
                  )}
                  {timelineExpanded && unifiedTimeline.length > 5 && (
                    <TouchableOpacity onPress={() => setTimelineExpanded(false)} style={{ paddingLeft: 32, marginTop: 4 }}>
                      <Text style={{ fontSize: 12, color: colors.primary, fontFamily: "Inter_500Medium" }}>Show less</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
          )}

          {isPodiumConnected && (
            <View
              style={[styles.actionCard, { backgroundColor: colors.card, borderColor: colors.border, padding: 0, overflow: "hidden" }]}
              onLayout={(e) => { podiumSectionY.current = e.nativeEvent.layout.y; }}
            >
              <TouchableOpacity
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 14 }}
                onPress={() => setPodiumExpanded(e => !e)}
                activeOpacity={0.7}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Feather name="message-circle" size={16} color="#3B82F6" />
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#3B82F6" }}>SMS Conversation</Text>
                  <View style={{ backgroundColor: "#3B82F610", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                    <Text style={{ fontSize: 9, color: "#3B82F680", fontFamily: "Inter_500Medium" }}>via Podium</Text>
                  </View>
                  {!podiumExpanded && messages.length > 0 && (
                    <View style={{ backgroundColor: colors.secondary, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                      <Text style={{ fontSize: 9, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{messages.length} msgs</Text>
                    </View>
                  )}
                </View>
                <Feather name="chevron-down" size={16} color={colors.mutedForeground} style={podiumExpanded ? { transform: [{ rotate: "180deg" }] } : {}} />
              </TouchableOpacity>

              {podiumExpanded && (
                <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 16, paddingBottom: 12 }}>
                  {messages.length === 0 ? (
                    <View style={styles.emptyMessages}>
                      <Feather name="message-square" size={32} color={colors.mutedForeground} />
                      <Text style={[styles.emptyMsgText, { color: colors.mutedForeground }]}>No messages yet</Text>
                      <Text style={[styles.emptyMsgSub, { color: colors.mutedForeground }]}>
                        Send a message below to start a conversation
                      </Text>
                    </View>
                  ) : (
                    <View style={[styles.messagesList, { marginTop: 12 }]}>
                      {[...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map(msg => {
                        return (
                          <View
                            key={msg.id}
                            style={[
                              styles.messageBubble,
                              msg.direction === "outbound"
                                ? { backgroundColor: "#3B82F615", borderColor: "#3B82F620", borderWidth: 1, alignSelf: "flex-end" }
                                : { backgroundColor: colors.secondary, borderColor: colors.border, borderWidth: 1, alignSelf: "flex-start" },
                            ]}
                          >
                            <Text style={[styles.msgBody, { color: colors.foreground }]}>{msg.body}</Text>
                            <View style={styles.podiumMeta}>
                              <Text style={[styles.msgTime, { color: colors.mutedForeground }]}>
                                {new Date(msg.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                              </Text>
                              {msg.channelType === "form" ? (
                                <Text style={{ fontSize: 9, color: "#F59E0B80", fontFamily: "Inter_400Regular", fontStyle: "italic" }}>Only visible in Podium</Text>
                              ) : (
                                <Text style={{ fontSize: 9, color: msg.direction === "outbound" ? "#3B82F680" : "#10B98180", fontFamily: "Inter_400Regular" }}>
                                  {msg.direction === "outbound" ? "Sent" : "Received"}
                                </Text>
                              )}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  )}

                  <View style={[styles.msgInputRow, { borderTopColor: colors.border }]}>
                    <TextInput
                      ref={smsInputRef}
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
  tabScroll: { borderBottomWidth: 1, marginHorizontal: 16, marginTop: 12, marginBottom: 4, flexGrow: 0, flexShrink: 0 },
  tabScrollContent: { gap: 2 },
  detailTab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minHeight: 38,
  },
  detailTabLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  tabBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6, minWidth: 18, alignItems: "center" },
  tabBadgeText: { fontSize: 10, fontFamily: "Inter_700Bold" },
  messagesHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  emptyMessages: { alignItems: "center", paddingVertical: 24, gap: 8 },
  emptyMsgText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  emptyMsgSub: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" },
  messagesList: { gap: 8 },
  messageBubble: { padding: 10, borderRadius: 12, gap: 4 },
  msgBody: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  msgTime: { fontSize: 10, fontFamily: "Inter_400Regular" },
  msgInputRow: { flexDirection: "row", gap: 8, paddingTop: 12, borderTopWidth: 1, alignItems: "flex-end" },
  msgInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, fontFamily: "Inter_400Regular", maxHeight: 120 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  historyContainer: { paddingHorizontal: 16, gap: 6, marginTop: 8 },
  historyNotes: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic" as const, marginTop: 2 },
  timelineLine: { gap: 0 },
  timelineRow: { flexDirection: "row" as const, gap: 10, minHeight: 44 },
  timelineNodeCol: { alignItems: "center" as const, width: 20 },
  timelineNode: { width: 20, height: 20, borderRadius: 10, alignItems: "center" as const, justifyContent: "center" as const, borderWidth: 1, zIndex: 1 },
  timelineConnector: { width: 1, flex: 1, marginTop: -1 },
  timelineContent: { flex: 1, paddingBottom: 10 },
  pulseEntry: { gap: 2 },
  pulseEntryHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
  editBtn: { padding: 2 },
  podiumMeta: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, marginTop: 4 },
  podiumBadge: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 },
  podiumCallBtn: { padding: 10, borderRadius: 10, borderWidth: 1, gap: 4 },
  podiumCallRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
  transcriptBlock: { marginLeft: 12, paddingLeft: 10, borderLeftWidth: 2, paddingVertical: 8, marginTop: 4 },
  editCard: { padding: 12, borderRadius: 10, borderWidth: 1, gap: 4 },
  editPickerRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
  editPickerItem: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, borderWidth: 1 },
  editNotesInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 8 },
  editSaveBtn: { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 6, alignItems: "center" as const },
  editCancelBtn: { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 6, alignItems: "center" as const },
});
