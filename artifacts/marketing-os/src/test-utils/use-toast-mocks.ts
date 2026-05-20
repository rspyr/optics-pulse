import { vi } from "vitest";

type UseToastModule = typeof import("@/hooks/use-toast");
type UseToastReturn = ReturnType<UseToastModule["useToast"]>;

/**
 * Build a typed stub of the value returned by `useToast()`. All fields default
 * to safe no-ops; pass `overrides` to set the ones a specific test cares
 * about. Because the return type is pinned to `ReturnType<useToast>`, adding
 * (or removing) a field on the real hook surfaces a typescript error at the
 * call site of `overrides` rather than silently returning `undefined`.
 */
export function makeUseToastStub(
  overrides: Partial<UseToastReturn> = {},
): UseToastReturn {
  const base: UseToastReturn = {
    toasts: [],
    toast: vi.fn(() => ({
      id: "stub-toast",
      dismiss: () => undefined,
      update: () => undefined,
    })) as unknown as UseToastReturn["toast"],
    dismiss: vi.fn() as unknown as UseToastReturn["dismiss"],
  };
  return { ...base, ...overrides };
}

/**
 * Build a `vi.mock` factory result for `@/hooks/use-toast` that provides every
 * real export with a typed default. Because `overrides` is
 * `Partial<UseToastModule>`, typescript surfaces a compile error if a new
 * export is added (or renamed/removed) without updating the helper — that's
 * the drift-proof part.
 *
 * Usage:
 *
 *     vi.mock("@/hooks/use-toast", async () => {
 *       const { mockUseToastModule, makeUseToastStub } = await import(
 *         "@/test-utils/use-toast-mocks",
 *       );
 *       return mockUseToastModule({
 *         useToast: () => makeUseToastStub(),
 *       });
 *     });
 */
export function mockUseToastModule(
  overrides: Partial<UseToastModule> = {},
): UseToastModule {
  const defaults: UseToastModule = {
    useToast: () => makeUseToastStub(),
    toast: vi.fn(() => ({
      id: "stub-toast",
      dismiss: () => undefined,
      update: () => undefined,
    })) as unknown as UseToastModule["toast"],
    reducer: ((state) => state) as UseToastModule["reducer"],
  };
  return { ...defaults, ...overrides };
}
