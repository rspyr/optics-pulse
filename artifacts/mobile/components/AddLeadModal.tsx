import React, { useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useApi } from "@/hooks/useApi";

interface PhoneMatch { id: number; name: string }

const CONTACT_PREF_OPTIONS: { key: string; label: string; icon: keyof typeof Feather.glyphMap; color: string }[] = [
  { key: "text_only", label: "Text Only", icon: "message-square", color: "#3B82F6" },
  { key: "spanish_speaking", label: "Spanish", icon: "globe", color: "#8B5CF6" },
  { key: "do_not_call", label: "DNC", icon: "phone-off", color: "#EF4444" },
];

interface CreatedLead { id: number; name: string }

interface AddLeadModalProps {
  visible: boolean;
  tenantId: number | null;
  onClose: () => void;
  onCreated: (lead: CreatedLead) => void;
  onResubmitted: (lead: CreatedLead) => void;
  onOpenLead: (id: number) => void;
}

export function AddLeadModal({
  visible,
  tenantId,
  onClose,
  onCreated,
  onResubmitted,
  onOpenLead,
}: AddLeadModalProps) {
  const colors = useColors();
  const { apiFetch } = useApi();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [source, setSource] = useState("");
  const [funnelId, setFunnelId] = useState<number | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [funnels, setFunnels] = useState<{ id: number; name: string }[]>([]);
  const [showSourceOptions, setShowSourceOptions] = useState(false);
  const [showFunnelOptions, setShowFunnelOptions] = useState(false);

  const [contactPreferences, setContactPreferences] = useState<string[]>([]);

  const [phoneMatch, setPhoneMatch] = useState<PhoneMatch | null>(null);
  const [phoneChecking, setPhoneChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setFirstName("");
      setLastName("");
      setPhone("");
      setEmail("");
      setSource("");
      setFunnelId(null);
      setContactPreferences([]);
      setPhoneMatch(null);
      setPhoneChecking(false);
      setSubmitting(false);
      setError(null);
      setShowSourceOptions(false);
      setShowFunnelOptions(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !tenantId) return;
    apiFetch(`/api/leads-hub/canonical-sources?tenantId=${tenantId}`)
      .then((d: any) => setSources(Array.isArray(d?.sources) ? d.sources : []))
      .catch(() => setSources([]));
    apiFetch(`/api/funnel-types?tenantId=${tenantId}`)
      .then((d: any) => {
        if (!Array.isArray(d)) { setFunnels([]); return; }
        setFunnels(
          d.filter((f: { isActive?: boolean }) => f.isActive !== false)
            .map((f: { id: number; name: string }) => ({ id: f.id, name: f.name })),
        );
      })
      .catch(() => setFunnels([]));
  }, [visible, tenantId, apiFetch]);

  useEffect(() => {
    const trimmed = phone.trim();
    if (!visible || !tenantId || !trimmed) {
      setPhoneMatch(null);
      setPhoneChecking(false);
      return;
    }
    setPhoneChecking(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const data = await apiFetch(
          `/api/leads-hub/phone-match?tenantId=${tenantId}&phone=${encodeURIComponent(trimmed)}`,
        );
        if (!cancelled) setPhoneMatch(data?.match ?? null);
      } catch {
        if (!cancelled) setPhoneMatch(null);
      } finally {
        if (!cancelled) setPhoneChecking(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [phone, visible, tenantId, apiFetch]);

  const handleSubmit = async () => {
    if (submitting || !tenantId) return;
    setError(null);
    if (!firstName.trim() || !lastName.trim() || !source.trim()) {
      setError("First name, last name, and source are required.");
      return;
    }
    setSubmitting(true);
    try {
      const data = await apiFetch(`/api/leads-hub/create?tenantId=${tenantId}`, {
        method: "POST",
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim() || null,
          email: email.trim() || null,
          source: source.trim(),
          funnelId,
          contactPreferences,
        }),
      });
      const created: CreatedLead = {
        id: data.id,
        name: [data.firstName, data.lastName].filter(Boolean).join(" ").trim()
          || `${firstName} ${lastName}`.trim(),
      };
      if (data.resubmitted) onResubmitted(created);
      else onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create lead.");
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = [styles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View style={styles.headerTitleRow}>
              <Feather name="user-plus" size={16} color={colors.primary} />
              <Text style={[styles.title, { color: colors.foreground }]}>Add Lead</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="x" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.row}>
              <View style={styles.col}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>FIRST NAME *</Text>
                <TextInput
                  style={inputStyle}
                  value={firstName}
                  onChangeText={setFirstName}
                  autoCapitalize="words"
                  placeholderTextColor={colors.mutedForeground}
                />
              </View>
              <View style={styles.col}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>LAST NAME *</Text>
                <TextInput
                  style={inputStyle}
                  value={lastName}
                  onChangeText={setLastName}
                  autoCapitalize="words"
                  placeholderTextColor={colors.mutedForeground}
                />
              </View>
            </View>

            <View>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>PHONE</Text>
              <TextInput
                style={inputStyle}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                placeholder="e.g. 555-123-4567"
                placeholderTextColor={colors.mutedForeground}
              />
              {phone.trim() ? (
                phoneChecking ? (
                  <Text style={[styles.hint, { color: colors.mutedForeground }]}>Checking…</Text>
                ) : phoneMatch ? (
                  <View style={styles.warnBox}>
                    <View style={styles.warnRow}>
                      <Feather name="alert-circle" size={12} color="#F59E0B" />
                      <Text style={styles.warnText}>Matches existing lead </Text>
                      <TouchableOpacity onPress={() => { onOpenLead(phoneMatch.id); onClose(); }}>
                        <Text style={styles.warnLink}>#{phoneMatch.id} ({phoneMatch.name})</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.warnSub}>Create will resubmit this lead, not add a new one.</Text>
                  </View>
                ) : (
                  <Text style={[styles.hint, { color: colors.mutedForeground }]}>No existing lead with this phone.</Text>
                )
              ) : null}
            </View>

            <View>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>EMAIL</Text>
              <TextInput
                style={inputStyle}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            <View>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>SOURCE *</Text>
              <TextInput
                style={inputStyle}
                value={source}
                onChangeText={setSource}
                placeholder="e.g. Facebook, Walk-in"
                placeholderTextColor={colors.mutedForeground}
                onFocus={() => setShowSourceOptions(true)}
              />
              {showSourceOptions && sources.length > 0 && (
                <View style={[styles.optionList, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  {sources.slice(0, 8).map(s => (
                    <TouchableOpacity
                      key={s}
                      style={styles.option}
                      onPress={() => { setSource(s); setShowSourceOptions(false); }}
                    >
                      <Text style={[styles.optionText, { color: colors.foreground }]}>{s}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {funnels.length > 0 && (
              <View>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>FUNNEL</Text>
                <TouchableOpacity
                  style={[styles.input, styles.selectInput, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                  onPress={() => setShowFunnelOptions(v => !v)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.selectText, { color: funnelId ? colors.foreground : colors.mutedForeground }]}>
                    {funnelId ? funnels.find(f => f.id === funnelId)?.name || "Auto / none" : "Auto / none"}
                  </Text>
                  <Feather name="chevron-down" size={14} color={colors.mutedForeground} />
                </TouchableOpacity>
                {showFunnelOptions && (
                  <View style={[styles.optionList, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <TouchableOpacity style={styles.option} onPress={() => { setFunnelId(null); setShowFunnelOptions(false); }}>
                      <Text style={[styles.optionText, { color: colors.foreground }]}>Auto / none</Text>
                    </TouchableOpacity>
                    {funnels.map(f => (
                      <TouchableOpacity key={f.id} style={styles.option} onPress={() => { setFunnelId(f.id); setShowFunnelOptions(false); }}>
                        <Text style={[styles.optionText, { color: funnelId === f.id ? colors.primary : colors.foreground }]}>{f.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            )}

            <View>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>CONTACT PREFERENCES</Text>
              <View style={styles.prefsRow}>
                {CONTACT_PREF_OPTIONS.map(opt => {
                  const selected = contactPreferences.includes(opt.key);
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[
                        styles.prefBadge,
                        {
                          backgroundColor: selected ? opt.color + "20" : colors.secondary + "40",
                          borderColor: selected ? opt.color + "60" : colors.border,
                        },
                      ]}
                      onPress={() => setContactPreferences(prev =>
                        prev.includes(opt.key) ? prev.filter(k => k !== opt.key) : [...prev, opt.key],
                      )}
                      activeOpacity={0.7}
                    >
                      <Feather name={opt.icon} size={11} color={selected ? opt.color : colors.mutedForeground} />
                      <Text style={[styles.prefText, { color: selected ? opt.color : colors.mutedForeground }]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {error && (
              <View style={styles.errorBox}>
                <Feather name="x-circle" size={12} color="#EF4444" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: colors.border }]}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
              <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.submitBtn,
                phoneMatch
                  ? { backgroundColor: "#F59E0B20", borderColor: "#F59E0B40" }
                  : { backgroundColor: colors.primary + "20", borderColor: colors.primary + "40" },
                submitting && { opacity: 0.5 },
              ]}
              onPress={handleSubmit}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={phoneMatch ? "#F59E0B" : colors.primary} />
              ) : (
                <Text style={[styles.submitText, { color: phoneMatch ? "#F59E0B" : colors.primary }]}>
                  {phoneMatch ? "Resubmit existing lead" : "Create lead"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, maxHeight: "92%" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  headerTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 15, fontFamily: "Inter_700Bold" },
  body: { flexGrow: 0 },
  bodyContent: { padding: 16, gap: 12 },
  row: { flexDirection: "row", gap: 10 },
  col: { flex: 1 },
  label: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1, marginBottom: 4 },
  input: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14, fontFamily: "Inter_400Regular" },
  selectInput: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  selectText: { fontSize: 14, fontFamily: "Inter_500Medium", flex: 1 },
  hint: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 4 },
  warnBox: { marginTop: 6, padding: 8, borderRadius: 6, backgroundColor: "#F59E0B15", borderWidth: 1, borderColor: "#F59E0B40" },
  warnRow: { flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" },
  warnText: { fontSize: 12, fontFamily: "Inter_500Medium", color: "#F59E0B" },
  warnLink: { fontSize: 12, fontFamily: "Inter_700Bold", color: "#F59E0B", textDecorationLine: "underline" },
  warnSub: { fontSize: 11, fontFamily: "Inter_400Regular", color: "#F59E0B", opacity: 0.8, marginTop: 2 },
  optionList: { borderRadius: 8, borderWidth: 1, marginTop: 4, overflow: "hidden" },
  option: { paddingHorizontal: 12, paddingVertical: 10 },
  optionText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  prefsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  prefBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, borderWidth: 1 },
  prefText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderRadius: 6, backgroundColor: "#EF444415", borderWidth: 1, borderColor: "#EF444440" },
  errorText: { fontSize: 12, fontFamily: "Inter_500Medium", color: "#EF4444", flex: 1 },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: 8, padding: 12, borderTopWidth: 1 },
  cancelBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  cancelText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  submitBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, minWidth: 140, alignItems: "center" },
  submitText: { fontSize: 13, fontFamily: "Inter_700Bold" },
});
