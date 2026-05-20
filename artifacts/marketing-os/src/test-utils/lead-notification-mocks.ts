import { vi } from "vitest";
import type React from "react";
import type {
  LeadNotificationContextType,
} from "@/contexts/lead-notification-context";

type LeadNotificationModule = typeof import("@/contexts/lead-notification-context");

const noopUnsub = (): (() => void) => () => undefined;

export function makeLeadNotificationStub(
  overrides: Partial<LeadNotificationContextType> = {},
): LeadNotificationContextType {
  const base: LeadNotificationContextType = {
    soundEnabled: false,
    setSoundEnabled: () => undefined,
    pendingNewLeads: [],
    dismissNewLead: () => undefined,
    newLeadSignal: 0,
    leadUpdatedSignal: 0,
    onReconnect: noopUnsub,
    latestPodiumNotification: null,
    clearPodiumNotification: () => undefined,
    onPodiumMessage: noopUnsub,
    latestCallbackDue: null,
    clearCallbackDue: () => undefined,
    playCallbackSound: () => undefined,
    onRuleRederiveComplete: noopUnsub,
    onRuleRederiveFailed: noopUnsub,
    onSelectedLeadsRederiveComplete: noopUnsub,
    onSelectedLeadsRederiveFailed: noopUnsub,
    onSelectedLeadsRederiveProgress: noopUnsub,
    onSelectedLeadsRederiveCancelled: noopUnsub,
  };
  return { ...base, ...overrides };
}

const PassthroughProvider: LeadNotificationModule["LeadNotificationProvider"] = ({
  children,
}: {
  children: React.ReactNode;
}) => children as React.ReactElement;

export function mockLeadNotificationModule(
  overrides: Partial<LeadNotificationModule> = {},
): LeadNotificationModule {
  const defaults: LeadNotificationModule = {
    LeadNotificationProvider: PassthroughProvider,
    useLeadNotification: () => makeLeadNotificationStub(),
    useOptionalLeadNotification: () => null,
  };
  return { ...defaults, ...overrides };
}

export function makeLeadNotificationHookMocks(
  overrides: Partial<LeadNotificationContextType> = {},
) {
  return {
    useLeadNotificationMock: vi.fn(
      (): LeadNotificationContextType => makeLeadNotificationStub(overrides),
    ),
    useOptionalLeadNotificationMock: vi.fn(
      (): LeadNotificationContextType | null => null,
    ),
  };
}
