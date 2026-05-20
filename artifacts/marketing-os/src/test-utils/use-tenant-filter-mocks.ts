import { vi } from "vitest";

type UseTenantFilterModule = typeof import("@/hooks/use-tenant-filter");
type TenantFilterValue = ReturnType<UseTenantFilterModule["useTenantFilter"]>;

/**
 * Build a typed stub of the value returned by `useTenantFilter()`. All
 * fields default to "no tenant selected, no agency, empty list, not
 * loading"; pass `overrides` to set the ones a specific test cares about.
 *
 * Because the return type is pinned to `ReturnType<useTenantFilter>`,
 * adding (or removing) a field on the real hook surfaces a typescript
 * error at the call site of `overrides` rather than silently returning
 * `undefined`.
 */
export function makeTenantFilterStub(
  overrides: Partial<TenantFilterValue> = {},
): TenantFilterValue {
  const base: TenantFilterValue = {
    tenants: [],
    tenantsLoading: false,
    localTenantId: null,
    effectiveTenantId: null,
    setSelectedTenantId: () => undefined,
    isAgency: false,
  };
  return { ...base, ...overrides };
}

/**
 * Build a `vi.mock` factory result for `@/hooks/use-tenant-filter` that
 * provides every real export with a typed default. `overrides` is typed as
 * `Partial<UseTenantFilterModule>` so a removed/renamed export is a
 * compile error rather than a silent `undefined`.
 *
 * Usage:
 *
 *     vi.mock("@/hooks/use-tenant-filter", async () => {
 *       const { mockUseTenantFilterModule, makeTenantFilterStub } =
 *         await import("@/test-utils/use-tenant-filter-mocks");
 *       return mockUseTenantFilterModule({
 *         useTenantFilter: () =>
 *           makeTenantFilterStub({ effectiveTenantId: 42, tenants: [{ id: 42, name: "Acme" }] }),
 *       });
 *     });
 */
export function mockUseTenantFilterModule(
  overrides: Partial<UseTenantFilterModule> = {},
): UseTenantFilterModule {
  const defaults: UseTenantFilterModule = {
    useTenantFilter: () => makeTenantFilterStub(),
  };
  return { ...defaults, ...overrides };
}

/**
 * Convenience builder for tests that want a `vi.fn`-backed `useTenantFilter`
 * with a default return value but the option to `mockReturnValueOnce` /
 * `mockImplementation` per-test.
 */
export function makeUseTenantFilterHookMock(
  overrides: Partial<TenantFilterValue> = {},
) {
  return vi.fn(
    (): TenantFilterValue => makeTenantFilterStub(overrides),
  );
}
