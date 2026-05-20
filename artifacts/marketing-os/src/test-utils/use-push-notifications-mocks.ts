import { vi } from "vitest";

type UsePushNotificationsModule =
  typeof import("@/hooks/use-push-notifications");
type UsePushNotificationsReturn = ReturnType<
  UsePushNotificationsModule["usePushNotifications"]
>;

/**
 * Build a typed stub of the value returned by `usePushNotifications()`. All
 * fields default to safe no-ops; pass `overrides` to set the ones a specific
 * test cares about. Because the return type is pinned to
 * `ReturnType<usePushNotifications>`, adding (or removing) a field on the real
 * hook surfaces a typescript error at the call site of `overrides` rather
 * than silently returning `undefined`.
 */
export function makeUsePushNotificationsStub(
  overrides: Partial<UsePushNotificationsReturn> = {},
): UsePushNotificationsReturn {
  const base: UsePushNotificationsReturn = {
    permission: "default",
    subscribed: false,
    loading: false,
    supported: false,
    subscribe: vi.fn(async () => false),
    unsubscribe: vi.fn(async () => false),
  };
  return { ...base, ...overrides };
}

/**
 * Build a `vi.mock` factory result for `@/hooks/use-push-notifications` that
 * provides every real export with a typed default. Because `overrides` is
 * `Partial<UsePushNotificationsModule>`, typescript surfaces a compile error
 * if a new export is added (or renamed/removed) without updating the helper —
 * that's the drift-proof part.
 *
 * Usage:
 *
 *     vi.mock("@/hooks/use-push-notifications", async () => {
 *       const { mockUsePushNotificationsModule, makeUsePushNotificationsStub } =
 *         await import("@/test-utils/use-push-notifications-mocks");
 *       return mockUsePushNotificationsModule({
 *         usePushNotifications: () => makeUsePushNotificationsStub(),
 *       });
 *     });
 */
export function mockUsePushNotificationsModule(
  overrides: Partial<UsePushNotificationsModule> = {},
): UsePushNotificationsModule {
  const defaults: UsePushNotificationsModule = {
    usePushNotifications: () => makeUsePushNotificationsStub(),
  };
  return { ...defaults, ...overrides };
}
