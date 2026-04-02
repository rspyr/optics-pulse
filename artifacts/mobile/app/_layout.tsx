import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { SocketProvider } from "@/contexts/SocketContext";
import { TenantProvider } from "@/contexts/TenantContext";
import { CsrFilterProvider } from "@/contexts/CsrFilterContext";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useColors } from "@/hooks/useColors";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function PushRegistrar() {
  usePushNotifications();
  return null;
}

function RootLayoutNav() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const colors = useColors();

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === "(tabs)" || segments[0] === "lead";

    if (!user && inAuthGroup) {
      router.replace("/login");
    } else if (user && segments[0] === "login") {
      router.replace("/(tabs)");
    }
  }, [user, loading, segments]);

  return (
    <Stack screenOptions={{
      headerBackTitle: "Back",
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.foreground,
      contentStyle: { backgroundColor: colors.background },
    }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="lead/[id]" options={{ title: "Lead Detail" }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <SocketProvider>
              <TenantProvider>
                <CsrFilterProvider>
                  <GestureHandlerRootView>
                    <KeyboardProvider>
                      <PushRegistrar />
                      <RootLayoutNav />
                    </KeyboardProvider>
                  </GestureHandlerRootView>
                </CsrFilterProvider>
              </TenantProvider>
            </SocketProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
