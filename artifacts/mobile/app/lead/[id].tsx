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
} from "react-native";
import { useLocalSearchParams, router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useApi } from "@/hooks/useApi";
import { useColors } from "@/hooks/useColors";

type ActionType = "call" | "text" | "voicemail_drop";

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

interface HistoryItem {
  id: number;
  actionType: string;
  outcome: string;
  notes: string | null;
  attemptedAt: string;
  userName?: string;
}

export default function LeadDetailScreen() {
  const params = useLocalSearchParams<{ id: string; lead?: string }>();
  const { apiFetch } = useApi();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === "web";

  const [lead, setLead] = useState<any>(() => {
    if (params.lead) {
      try { return JSON.parse(params.lead); } catch { return null; }
    }
    return null;
  });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [actionType, setActionType] = useState<ActionType>("call");
  const [submitting, setSubmitting] = useState(false);
  const [notes, setNotes] = useState("");
  const [showDeadMenu, setShowDeadMenu] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchLead = useCallback(async () => {
    try {
      setFetchError(null);
      const data = await apiFetch(`/api/leads/${params.id}`);
      setLead(data);
    } catch (err: any) {
      console.error("[LeadDetail] Failed to fetch lead:", err);
      setFetchError(err?.message || "Failed to load lead");
    }
  }, [apiFetch, params.id]);

  const fetchHistory = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/leads-hub/${params.id}/history`);
      setHistory(data.attempts || []);
    } catch (err) {
      console.error("[LeadDetail] Failed to fetch history:", err);
    }
  }, [apiFetch, params.id]);

  useEffect(() => {
    if (!lead) fetchLead();
    fetchHistory();
  }, []);

  const submitAction = async (result: string) => {
    if (submitting) return;
    setSubmitting(true);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const body: any = { leadId: Number(params.id), actionType, notes: notes || undefined };
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

  const statusColor = lead.hubStatus === "appt_set" ? colors.emerald :
    lead.hubStatus === "dead" ? colors.red :
    lead.hubStatus === "call_back" ? colors.purple :
    lead.hubStatus === "day_5_old" ? colors.mutedForeground : colors.primary;

  const results = actionType === "call" ? CALL_RESULTS : actionType === "text" ? TEXT_RESULTS : [];
  const isTerminal = lead.hubStatus === "appt_set" || lead.hubStatus === "dead";

  return (
    <>
      <Stack.Screen options={{
        title: `${lead.firstName} ${lead.lastName}`,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
      }} />
      <ScrollView
        style={[styles.container, { backgroundColor: colors.background }]}
        contentContainerStyle={{ paddingBottom: isWeb ? 34 + 20 : insets.bottom + 20 }}
      >
        <View style={[styles.contactCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.contactHeader}>
            <View style={[styles.avatar, { backgroundColor: colors.primary + "20" }]}>
              <Text style={[styles.avatarText, { color: colors.primary }]}>
                {lead.firstName?.[0]}{lead.lastName?.[0]}
              </Text>
            </View>
            <View style={styles.contactInfo}>
              <Text style={[styles.contactName, { color: colors.foreground }]}>
                {lead.firstName} {lead.lastName}
              </Text>
              <View style={[styles.statusBadge, { backgroundColor: statusColor + "20" }]}>
                <Text style={[styles.statusText, { color: statusColor }]}>
                  {(lead.hubStatus || "unknown").replace(/_/g, " ").toUpperCase()}
                </Text>
              </View>
            </View>
          </View>

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
                <Text style={[styles.detailText, { color: colors.foreground }]}>{lead.phone}</Text>
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
            {lead.leadType && (
              <View style={styles.detailRow}>
                <Feather name="layers" size={14} color={colors.mutedForeground} />
                <Text style={[styles.detailText, { color: colors.foreground }]}>{lead.leadType}</Text>
              </View>
            )}
          </View>
        </View>

        {!isTerminal && (
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

        <TouchableOpacity
          style={[styles.historyToggle, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => setShowHistory(!showHistory)}
        >
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
            Activity History ({history.length})
          </Text>
          <Feather name={showHistory ? "chevron-up" : "chevron-down"} size={18} color={colors.mutedForeground} />
        </TouchableOpacity>

        {showHistory && history.map(item => (
          <View key={item.id} style={[styles.historyItem, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.historyHeader}>
              <Feather
                name={item.actionType === "call" ? "phone" : item.actionType === "text" ? "message-square" : "voicemail"}
                size={14}
                color={colors.primary}
              />
              <Text style={[styles.historyAction, { color: colors.foreground }]}>
                {item.actionType} — {(item.outcome || "").replace(/_/g, " ")}
              </Text>
            </View>
            {item.userName && (
              <Text style={[styles.historyMeta, { color: colors.mutedForeground }]}>by {item.userName}</Text>
            )}
            <Text style={[styles.historyMeta, { color: colors.mutedForeground }]}>
              {new Date(item.attemptedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </Text>
            {item.notes && <Text style={[styles.historyNotes, { color: colors.foreground }]}>{item.notes}</Text>}
          </View>
        ))}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  contactCard: { margin: 16, padding: 16, borderRadius: 14, borderWidth: 1, gap: 14 },
  contactHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 18, fontFamily: "Inter_700Bold" },
  contactInfo: { flex: 1, gap: 4 },
  contactName: { fontSize: 18, fontFamily: "Inter_700Bold" },
  statusBadge: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  statusText: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  contactActions: { flexDirection: "row", gap: 10 },
  contactBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 10 },
  contactBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  detailRows: { gap: 8 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  detailText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  actionCard: { marginHorizontal: 16, marginBottom: 12, padding: 16, borderRadius: 14, borderWidth: 1, gap: 12 },
  sectionTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  actionTypeTabs: { flexDirection: "row", gap: 8 },
  actionTypeTab: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 10 },
  actionTypeText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  notesInput: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 14, fontFamily: "Inter_400Regular", minHeight: 60, textAlignVertical: "top" },
  resultGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  resultBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, minWidth: "30%" as any },
  resultBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  deadBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  deadBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  deadReasons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  deadReasonBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  deadReasonText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  historyToggle: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginHorizontal: 16, marginBottom: 8, padding: 14, borderRadius: 14, borderWidth: 1 },
  historyItem: { marginHorizontal: 16, marginBottom: 6, padding: 12, borderRadius: 10, borderWidth: 1, gap: 4 },
  historyHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  historyAction: { fontSize: 14, fontFamily: "Inter_500Medium", textTransform: "capitalize" as const },
  historyMeta: { fontSize: 12, fontFamily: "Inter_400Regular" },
  historyNotes: { fontSize: 13, fontFamily: "Inter_400Regular", fontStyle: "italic" as const, marginTop: 2 },
});
