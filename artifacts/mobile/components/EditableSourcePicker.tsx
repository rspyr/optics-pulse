import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useApi } from "@/hooks/useApi";
import { useColors } from "@/hooks/useColors";

interface EditableSourcePickerProps {
  leadId: number;
  source: string;
  tenantId?: number | null;
  onSourceChanged: (newSource: string) => void;
  compact?: boolean;
}

function getSourceColor(source: string): { bg: string; text: string; border: string } {
  if (source.includes("Google")) return { bg: "#3B82F620", text: "#60A5FA", border: "#3B82F630" };
  if (source.includes("Meta") || source.includes("Facebook") || source.includes("Instagram")) return { bg: "#6366F120", text: "#818CF8", border: "#6366F130" };
  if (source.includes("Direct Mail")) return { bg: "#F59E0B20", text: "#FBBF24", border: "#F59E0B30" };
  if (source.includes("YouTube") || source.includes("TikTok")) return { bg: "#EC489920", text: "#F472B6", border: "#EC489930" };
  if (source === "Unknown") return { bg: "#F9731620", text: "#FB923C", border: "#F9731630" };
  return { bg: "#FFFFFF08", text: "#FFFFFF80", border: "#FFFFFF18" };
}

export function EditableSourcePicker({ leadId, source, tenantId, onSourceChanged, compact }: EditableSourcePickerProps) {
  const { apiFetch } = useApi();
  const colors = useColors();
  const [canonicalSources, setCanonicalSources] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  const fetchCanonicalSources = React.useCallback(() => {
    const qs = tenantId ? `?tenantId=${tenantId}` : "";
    apiFetch(`/api/leads-hub/canonical-sources${qs}`)
      .then((data: { sources?: string[] }) => setCanonicalSources(data.sources || []))
      .catch(() => {});
  }, [apiFetch, tenantId]);

  useEffect(() => {
    fetchCanonicalSources();
  }, [fetchCanonicalSources]);

  const handleOpen = () => {
    fetchCanonicalSources();
    setOpen(true);
  };

  const handleSelect = async (newSource: string) => {
    setOpen(false);
    if (newSource === source) return;
    setSaving(true);
    try {
      const data = await apiFetch(`/api/leads-hub/${leadId}/source`, {
        method: "PATCH",
        body: JSON.stringify({ source: newSource, tenantId }),
      });
      onSourceChanged(data.source);
    } catch {}
    setSaving(false);
  };

  const sourceColors = getSourceColor(source);
  const allOptions = canonicalSources.includes(source) ? canonicalSources : [source, ...canonicalSources];
  const hasOptions = canonicalSources.length > 0;

  return (
    <>
      <TouchableOpacity
        onPress={() => handleOpen()}
        activeOpacity={0.7}
        style={[
          styles.badge,
          { backgroundColor: sourceColors.bg, borderColor: sourceColors.border },
          compact && styles.badgeCompact,
        ]}
      >
        {saving ? (
          <ActivityIndicator size={10} color={sourceColors.text} />
        ) : (
          <Text style={[styles.badgeText, { color: sourceColors.text }, compact && styles.badgeTextCompact]}>
            {source}
          </Text>
        )}
        {hasOptions && <Feather name="edit-2" size={compact ? 9 : 10} color={sourceColors.text} style={{ opacity: 0.5 }} />}
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <TouchableOpacity
          style={styles.overlay}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          <View style={[styles.sheet, { backgroundColor: colors.card }]}>
            <View style={styles.handle} />
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Change Source</Text>
            <ScrollView style={styles.optionsList} bounces={false}>
              {allOptions.map(s => {
                const sc = getSourceColor(s);
                const isActive = s === source;
                return (
                  <TouchableOpacity
                    key={s}
                    onPress={() => handleSelect(s)}
                    style={[
                      styles.option,
                      { borderColor: colors.border },
                      isActive && { backgroundColor: colors.primary + "15", borderColor: colors.primary + "30" },
                    ]}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.optionDot, { backgroundColor: sc.text }]} />
                    <Text style={[styles.optionText, { color: isActive ? colors.primary : colors.foreground }]}>
                      {s}
                    </Text>
                    {isActive && <Feather name="check" size={16} color={colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              onPress={() => setOpen(false)}
              style={[styles.cancelBtn, { borderColor: colors.border }]}
              activeOpacity={0.7}
            >
              <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeCompact: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  badgeTextCompact: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingBottom: 36,
    paddingTop: 12,
    maxHeight: "60%",
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#888",
    alignSelf: "center",
    marginBottom: 12,
  },
  sheetTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    marginBottom: 12,
  },
  optionsList: {
    marginBottom: 12,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 6,
  },
  optionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  optionText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    flex: 1,
  },
  cancelBtn: {
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
  },
  cancelText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
