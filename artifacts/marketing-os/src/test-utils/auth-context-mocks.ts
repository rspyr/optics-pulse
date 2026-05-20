import { vi } from "vitest";
import type React from "react";

type AuthContextModule = typeof import("@/components/auth-context");
type AuthContextValue = ReturnType<AuthContextModule["useAuth"]>;

/**
 * Build a typed stub of the value returned by `useAuth()`. All fields default
 * to safe no-ops; pass `overrides` to set the ones a specific test cares
 * about. Because the return type is pinned to `ReturnType<useAuth>`, adding
 * (or removing) a field on the real context surfaces a typescript error at
 * the call site of `overrides` rather than silently returning `undefined`.
 */
export function makeAuthStub(
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  const base: AuthContextValue = {
    user: null,
    loading: false,
    login: async () => {
      throw new Error("auth stub: login not configured");
    },
    logout: async () => undefined,
    isAgency: false,
    isClient: false,
    selectedTenantId: null,
    setSelectedTenantId: () => undefined,
    effectiveTenantId: null,
    tenantSelectionMade: false,
  };
  return { ...base, ...overrides };
}

const PassthroughProvider: AuthContextModule["AuthProvider"] = ({
  children,
}: {
  children: React.ReactNode;
}) => children as React.ReactElement;

/**
 * Build a `vi.mock` factory result for `@/components/auth-context` that
 * provides every real export with a typed default. Because `overrides` is
 * `Partial<AuthContextModule>`, typescript surfaces a compile error if a new
 * export is added (or renamed/removed) without updating the helper — that's
 * the drift-proof part.
 *
 * Usage:
 *
 *     vi.mock("@/components/auth-context", async () => {
 *       const { mockAuthContextModule, makeAuthStub } = await import(
 *         "@/test-utils/auth-context-mocks",
 *       );
 *       return mockAuthContextModule({
 *         useAuth: () => makeAuthStub({ effectiveTenantId: 42 }),
 *       });
 *     });
 */
export function mockAuthContextModule(
  overrides: Partial<AuthContextModule> = {},
): AuthContextModule {
  const defaults: AuthContextModule = {
    AuthProvider: PassthroughProvider,
    useAuth: () => makeAuthStub(),
  };
  return { ...defaults, ...overrides };
}
