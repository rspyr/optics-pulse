import React from "react";
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
  attemptCount?: number;
}

interface LeadCardProps {
  lead: Lead;
  onPress: (lead: Lead) => void;
  showBadge?: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function getUrgencyColor(lead: Lead, colors: any): string {
  if (!lead.hubStatus) return colors.mutedForeground;
  if (lead.hubStatus === "day_1") return colors.emerald;
  if (lead.hubStatus === "day_2") return colors.amber;
  if (lead.hubStatus === "day_3" || lead.hubStatus === "day_4") return colors.red;
  if (lead.hubStatus === "call_back") return colors.purple;
  if (lead.hubStatus === "appt_booked") return colors.cyan;
  if (lead.hubStatus === "day_5_old") return colors.mutedForeground;
  return colors.mutedForeground;
}

export function LeadCard({ lead, onPress, showBadge }: LeadCardProps) {
  const colors = useColors();
  const urgencyColor = getUrgencyColor(lead, colors);

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={() => onPress(lead)}
      activeOpacity={0.7}
    >
      <View style={[styles.urgencyBar, { backgroundColor: urgencyColor }]} />
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
            {lead.firstName} {lead.lastName}
          </Text>
          <Text style={[styles.time, { color: colors.mutedForeground }]}>
            {timeAgo(lead.createdAt)}
          </Text>
        </View>
        <View style={styles.details}>
          {lead.source && (
            <View style={styles.tag}>
              <Feather name="target" size={11} color={colors.mutedForeground} />
              <Text style={[styles.tagText, { color: colors.mutedForeground }]}>{lead.source}</Text>
            </View>
          )}
          {lead.interestType && (
            <View style={styles.tag}>
              <Feather name="tag" size={11} color={colors.mutedForeground} />
              <Text style={[styles.tagText, { color: colors.mutedForeground }]}>{lead.interestType}</Text>
            </View>
          )}
          {lead.attemptCount != null && lead.attemptCount > 0 && (
            <View style={styles.tag}>
              <Feather name="phone-call" size={11} color={colors.mutedForeground} />
              <Text style={[styles.tagText, { color: colors.mutedForeground }]}>{lead.attemptCount}x</Text>
            </View>
          )}
        </View>
        {showBadge && (
          <View style={[styles.badge, { backgroundColor: urgencyColor + "20" }]}>
            <Text style={[styles.badgeText, { color: urgencyColor }]}>{showBadge}</Text>
          </View>
        )}
        {lead.callbackAt && (
          <View style={styles.callbackRow}>
            <Feather name="clock" size={11} color={colors.purple} />
            <Text style={[styles.callbackText, { color: colors.purple }]}>
              Callback: {new Date(lead.callbackAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </Text>
          </View>
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
  content: { flex: 1, padding: 14, gap: 6 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", flex: 1 },
  time: { fontSize: 12, fontFamily: "Inter_400Regular" },
  details: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tag: { flexDirection: "row", alignItems: "center", gap: 3 },
  tagText: { fontSize: 12, fontFamily: "Inter_400Regular" },
  badge: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  callbackRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  callbackText: { fontSize: 12, fontFamily: "Inter_500Medium" },
});
