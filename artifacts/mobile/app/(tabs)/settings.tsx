import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
  Alert,
  ActivityIndicator,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useAuth } from "@/contexts/AuthContext";
import { useApi } from "@/hooks/useApi";
import { useColors } from "@/hooks/useColors";

const API_BASE = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const { apiFetch } = useApi();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === "web";

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [podiumLoading, setPodiumLoading] = useState(false);

  const handleChangePassword = async () => {
    setPasswordMsg(null);
    if (!currentPassword || !newPassword) {
      setPasswordMsg({ type: "error", text: "Please fill in all fields" });
      return;
    }
    if (newPassword.length < 6) {
      setPasswordMsg({ type: "error", text: "New password must be at least 6 characters" });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: "error", text: "Passwords do not match" });
      return;
    }

    setPasswordLoading(true);
    try {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setPasswordMsg({ type: "success", text: "Password changed successfully" });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setPasswordMsg({ type: "error", text: err instanceof Error ? err.message : "Failed to change password" });
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleConnectPodium = async () => {
    setPodiumLoading(true);
    try {
      const data = await apiFetch("/api/oauth/podium/authorize");
      if (data.url) {
        await Linking.openURL(data.url);
      }
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to connect Podium");
    } finally {
      setPodiumLoading(false);
    }
  };

  const handleDisconnectPodium = async () => {
    const doDisconnect = async () => {
      try {
        await apiFetch("/api/oauth/podium/disconnect", { method: "POST" });
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert("Disconnected", "Podium has been disconnected successfully.");
      } catch (err) {
        Alert.alert("Error", err instanceof Error ? err.message : "Failed to disconnect Podium");
      }
    };

    if (Platform.OS === "web") {
      doDisconnect();
    } else {
      Alert.alert(
        "Disconnect Podium",
        "Are you sure you want to disconnect your Podium account?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Disconnect", style: "destructive", onPress: doDisconnect },
        ]
      );
    }
  };

  const handleLogout = () => {
    if (Platform.OS === "web") {
      logout();
    } else {
      Alert.alert("Sign Out", "Are you sure you want to sign out?", [
        { text: "Cancel", style: "cancel" },
        { text: "Sign Out", style: "destructive", onPress: logout },
      ]);
    }
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: isWeb ? 67 + 16 : insets.top + 16,
          paddingBottom: isWeb ? 34 + 90 : insets.bottom + 90,
        },
      ]}
    >
      <Text style={[styles.screenTitle, { color: colors.foreground }]}>Settings</Text>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardHeader}>
          <Feather name="user" size={18} color={colors.primary} />
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>Account</Text>
        </View>
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <View style={styles.fieldRow}>
          <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Name</Text>
          <Text style={[styles.fieldValue, { color: colors.foreground }]}>{user?.name || "--"}</Text>
        </View>
        <View style={styles.fieldRow}>
          <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Email</Text>
          <Text style={[styles.fieldValue, { color: colors.foreground }]}>{user?.email || "--"}</Text>
        </View>
        <View style={styles.fieldRow}>
          <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Role</Text>
          <Text style={[styles.fieldValue, { color: colors.foreground }]}>{user?.role?.replace("_", " ") || "--"}</Text>
        </View>
        {user?.tenantName && (
          <View style={styles.fieldRow}>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Tenant</Text>
            <Text style={[styles.fieldValue, { color: colors.foreground }]}>{user.tenantName}</Text>
          </View>
        )}
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardHeader}>
          <Feather name="lock" size={18} color={colors.amber} />
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>Change Password</Text>
        </View>
        <View style={[styles.divider, { backgroundColor: colors.border }]} />

        {passwordMsg && (
          <View style={[styles.msgBox, { backgroundColor: passwordMsg.type === "success" ? "#10B98120" : "#EF444420" }]}>
            <Text style={[styles.msgText, { color: passwordMsg.type === "success" ? "#10B981" : "#EF4444" }]}>
              {passwordMsg.text}
            </Text>
          </View>
        )}

        <TextInput
          style={[styles.input, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
          placeholder="Current password"
          placeholderTextColor={colors.mutedForeground}
          secureTextEntry
          value={currentPassword}
          onChangeText={setCurrentPassword}
          autoCapitalize="none"
        />
        <TextInput
          style={[styles.input, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
          placeholder="New password"
          placeholderTextColor={colors.mutedForeground}
          secureTextEntry
          value={newPassword}
          onChangeText={setNewPassword}
          autoCapitalize="none"
        />
        <TextInput
          style={[styles.input, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
          placeholder="Confirm new password"
          placeholderTextColor={colors.mutedForeground}
          secureTextEntry
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          autoCapitalize="none"
        />
        <TouchableOpacity
          style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: passwordLoading ? 0.6 : 1 }]}
          onPress={handleChangePassword}
          disabled={passwordLoading}
          activeOpacity={0.7}
        >
          {passwordLoading ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Text style={styles.primaryBtnText}>Update Password</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardHeader}>
          <Feather name="message-circle" size={18} color="#8B5CF6" />
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>Podium Integration</Text>
        </View>
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <Text style={[styles.helpText, { color: colors.mutedForeground }]}>
          Connect your Podium account to send and receive text messages directly from the app.
        </Text>
        <View style={styles.podiumActions}>
          <TouchableOpacity
            style={[styles.outlineBtn, { borderColor: "#8B5CF6" }]}
            onPress={handleConnectPodium}
            disabled={podiumLoading}
            activeOpacity={0.7}
          >
            {podiumLoading ? (
              <ActivityIndicator size="small" color="#8B5CF6" />
            ) : (
              <>
                <Feather name="link" size={15} color="#8B5CF6" />
                <Text style={[styles.outlineBtnText, { color: "#8B5CF6" }]}>Connect Podium</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.outlineBtn, { borderColor: colors.red }]}
            onPress={handleDisconnectPodium}
            activeOpacity={0.7}
          >
            <Feather name="link-2" size={15} color={colors.red} />
            <Text style={[styles.outlineBtnText, { color: colors.red }]}>Disconnect</Text>
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity
        style={[styles.logoutCard, { backgroundColor: colors.card, borderColor: colors.red + "30" }]}
        onPress={handleLogout}
        activeOpacity={0.7}
      >
        <Feather name="log-out" size={18} color={colors.red} />
        <Text style={[styles.logoutText, { color: colors.red }]}>Sign Out</Text>
      </TouchableOpacity>

      <Text style={[styles.versionText, { color: colors.mutedForeground }]}>
        Pulse Mobile v1.0.0
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 16, gap: 16 },
  screenTitle: { fontSize: 22, fontFamily: "Inter_700Bold" },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  divider: { height: 1 },
  fieldRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  fieldLabel: { fontSize: 13, fontFamily: "Inter_400Regular" },
  fieldValue: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  input: {
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  primaryBtn: {
    height: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#FFF" },
  msgBox: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  msgText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  helpText: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  podiumActions: { flexDirection: "row", gap: 10 },
  outlineBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
  },
  outlineBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  logoutCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  logoutText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  versionText: { fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 8 },
});
