import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

interface StatCardProps {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string | number;
  color?: string;
  subtitle?: string;
}

export function StatCard({ icon, label, value, color, subtitle }: StatCardProps) {
  const colors = useColors();
  const iconColor = color || colors.primary;

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.iconBg, { backgroundColor: iconColor + "15" }]}>
        <Feather name={icon} size={18} color={iconColor} />
      </View>
      <Text style={[styles.value, { color: colors.foreground }]}>{value}</Text>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
      {subtitle && <Text style={[styles.subtitle, { color: iconColor }]}>{subtitle}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
  },
  iconBg: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  value: { fontSize: 22, fontFamily: "Inter_700Bold" },
  label: { fontSize: 12, fontFamily: "Inter_500Medium" },
  subtitle: { fontSize: 11, fontFamily: "Inter_600SemiBold", marginTop: 2 },
});
