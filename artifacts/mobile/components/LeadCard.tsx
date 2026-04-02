import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

interface Lead {
  id: number;
  firstName: string;
  lastName: string;
  phone?: string | null;
  source?: string | null;
  leadType?: string | null;
  interestType?: string | null;
  hubStatus?: string | null;
  createdAt: string;
  dayInSequence?: number;
  callbackAt?: string | null;
  nextPassAt?: string | null;
  passIntervalMinutes?: number | null;
  attemptCount?: number;
  contactPreferences?: string[];
  assignedUserName?: string;
}

interface LeadCardProps {
  lead: Lead;
  onPress: (lead: Lead) => void;
  showBadge?: string;
}

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

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === "1") return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return phone;
}

function formatElapsed(ms: number): string {
  if (ms < 0) return "0s";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function useTickingTimer(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return tick;
}

function TimerBadge({ createdAt, nextPassAt, passIntervalMinutes }: { createdAt: string; nextPassAt?: string | null; passIntervalMinutes?: number | null }) {
  useTickingTimer();
  const now = Date.now();

  if (nextPassAt) {
    const targetMs = new Date(nextPassAt).getTime();
    const remainingMs = targetMs - now;

    if (remainingMs > 0) {
      const totalIntervalMs = (passIntervalMinutes ?? 1440) * 60 * 1000;
      const fraction = totalIntervalMs > 0 ? Math.max(0, remainingMs / totalIntervalMs) : 0;
      const color = remainingMs <= 60000 ? "#EF4444" : fraction > 0.5 ? "#10B981" : fraction > 0.2 ? "#F59E0B" : "#EF4444";

      return (
        <View style={[timerStyles.badge, { backgroundColor: color + "20" }]}>
          <Feather name="clock" size={10} color={color} />
          <Text style={[timerStyles.text, { color }]}>{formatCountdown(remainingMs)}</Text>
        </View>
      );
    }
  }

  const elapsed = now - new Date(createdAt).getTime();
  const mins = Math.floor(elapsed / 60000);
  const color = mins < 10 ? "#10B981" : mins < 60 ? "#F59E0B" : "#8B919E";

  return (
    <View style={[timerStyles.badge, { backgroundColor: color + "20" }]}>
      <Feather name="clock" size={10} color={color} />
      <Text style={[timerStyles.text, { color }]}>{formatElapsed(elapsed)} ago</Text>
    </View>
  );
}

const timerStyles = StyleSheet.create({
  badge: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  text: { fontSize: 10, fontFamily: "Inter_600SemiBold", fontVariant: ["tabular-nums"] },
});

export function LeadCard({ lead, onPress }: LeadCardProps) {
  const colors = useColors();
  const dayBadge = DAY_BADGE_CONFIG[lead.hubStatus || ""] || null;
  const urgencyColor = dayBadge?.color || colors.mutedForeground;
  const prefs = lead.contactPreferences || [];

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={() => onPress(lead)}
      activeOpacity={0.7}
    >
      <View style={[styles.urgencyBar, { backgroundColor: urgencyColor }]} />
      <View style={styles.content}>
        <View style={styles.topRow}>
          <View style={styles.nameRow}>
            <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
              {lead.firstName} {lead.lastName}
            </Text>
            {dayBadge && (
              <View style={[styles.dayBadge, { backgroundColor: dayBadge.color + "20", borderColor: dayBadge.color + "30" }]}>
                <Text style={[styles.dayBadgeText, { color: dayBadge.color }]}>{dayBadge.label}</Text>
              </View>
            )}
          </View>
          <TimerBadge createdAt={lead.createdAt} nextPassAt={lead.nextPassAt} passIntervalMinutes={lead.passIntervalMinutes} />
        </View>

        <View style={styles.details}>
          {lead.phone && (
            <View style={styles.tag}>
              <Feather name="phone" size={11} color={colors.mutedForeground} />
              <Text style={[styles.tagText, { color: colors.mutedForeground }]}>{formatPhone(lead.phone)}</Text>
            </View>
          )}
          {lead.source && (
            <View style={[styles.sourceBadge, { backgroundColor: colors.secondary + "40" }]}>
              <Text style={[styles.sourceText, { color: colors.secondaryForeground }]}>{lead.source}</Text>
            </View>
          )}
          {lead.leadType && (
            <View style={[styles.leadTypeBadge, { backgroundColor: "#8B5CF620" }]}>
              <Feather name="filter" size={10} color="#8B5CF6" />
              <Text style={styles.leadTypeText}>{lead.leadType}</Text>
            </View>
          )}
          {lead.interestType && (
            <View style={styles.tag}>
              <Feather name="tag" size={11} color={colors.mutedForeground} />
              <Text style={[styles.tagText, { color: colors.mutedForeground }]}>{lead.interestType}</Text>
            </View>
          )}
        </View>

        <View style={styles.bottomRow}>
          <View style={styles.flagsRow}>
            {prefs.map(pref => {
              const cfg = CONTACT_FLAGS[pref];
              if (!cfg) return null;
              return (
                <View key={pref} style={[styles.flagBadge, { backgroundColor: cfg.color + "20" }]}>
                  <Feather name={cfg.icon} size={10} color={cfg.color} />
                  <Text style={[styles.flagText, { color: cfg.color }]}>{cfg.label}</Text>
                </View>
              );
            })}
            {lead.attemptCount != null && lead.attemptCount > 0 && (
              <View style={styles.tag}>
                <Feather name="phone-call" size={11} color={colors.mutedForeground} />
                <Text style={[styles.tagText, { color: colors.mutedForeground }]}>{lead.attemptCount}x</Text>
              </View>
            )}
          </View>

          {lead.callbackAt && (
            <View style={[styles.callbackBadge, { backgroundColor: "#F59E0B20" }]}>
              <Feather name="clock" size={10} color="#F59E0B" />
              <Text style={[styles.callbackText, { color: "#F59E0B" }]}>
                CB {new Date(lead.callbackAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </Text>
            </View>
          )}
        </View>

        {lead.assignedUserName && (
          <Text style={[styles.assignedText, { color: colors.mutedForeground }]} numberOfLines={1}>
            {lead.assignedUserName}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 10,
  },
  urgencyBar: { width: 4 },
  content: { flex: 1, padding: 12, gap: 6 },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", flexShrink: 1 },
  dayBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, borderWidth: 1 },
  dayBadgeText: { fontSize: 10, fontFamily: "Inter_700Bold", fontVariant: ["tabular-nums"] },
  details: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  tag: { flexDirection: "row", alignItems: "center", gap: 3 },
  tagText: { fontSize: 12, fontFamily: "Inter_400Regular" },
  sourceBadge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  sourceText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  leadTypeBadge: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  leadTypeText: { fontSize: 11, fontFamily: "Inter_500Medium", color: "#8B5CF6" },
  bottomRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  flagsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" },
  flagBadge: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  flagText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  callbackBadge: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  callbackText: { fontSize: 10, fontFamily: "Inter_500Medium" },
  assignedText: { fontSize: 10, fontFamily: "Inter_400Regular", marginTop: 2 },
});
