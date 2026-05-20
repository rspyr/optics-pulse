import { vi } from "vitest";

type ApiClientReactModule = typeof import("@workspace/api-client-react");

/**
 * Safe default return value for any auto-generated hook from
 * `@workspace/api-client-react`. The shape intentionally covers BOTH react-query
 * query results (`data` / `isLoading` / `refetch`) AND mutation results
 * (`mutate` / `mutateAsync` / `isPending` / `reset`) so a single stub satisfies
 * both styles of consumer-side destructuring. Components that read only the
 * fields they care about will see safe no-op values; nothing fires a real
 * fetch.
 */
export function makeApiClientHookStub<T = undefined>(data?: T) {
  const noopAsync = async () => undefined;
  return {
    // useQuery-style fields
    data: data as T,
    error: null,
    isLoading: false,
    isFetching: false,
    isPending: false,
    isError: false,
    isSuccess: data !== undefined,
    status: "idle" as const,
    refetch: vi.fn(noopAsync),
    // useMutation-style fields
    mutate: vi.fn(),
    mutateAsync: vi.fn(noopAsync),
    reset: vi.fn(),
    variables: undefined,
  };
}

/**
 * Build a `vi.mock` factory result for `@workspace/api-client-react` that:
 *
 *   1. Auto-stubs every exported `use*` hook with `makeApiClientHookStub()`
 *      so adding a new hook to the generated client doesn't blow up tests
 *      that never opted into mocking it. No real fetches are issued.
 *   2. Keeps every other export (query-key helpers, URL builders, type
 *      re-exports, schemas) wired to the actual generated implementation so
 *      callers can keep importing `getXxxQueryKey` / types without a second
 *      mock layer.
 *   3. Lets callers pass typed `overrides` keyed by the real module's
 *      exports. Because `overrides` is `Partial<ApiClientReactModule>`,
 *      typescript surfaces a single compile error when an override targets a
 *      hook that has been removed/renamed in the generated client — that's
 *      the drift-proof part.
 *
 * Usage:
 *
 *     vi.mock("@workspace/api-client-react", async () => {
 *       const { mockApiClientReactModule } = await import(
 *         "@/test-utils/api-client-react-mocks",
 *       );
 *       return mockApiClientReactModule({
 *         useListTenants: () => ({ ...makeApiClientHookStub(), data: tenants }),
 *       });
 *     });
 */
export async function mockApiClientReactModule(
  overrides: Partial<ApiClientReactModule> = {},
): Promise<ApiClientReactModule> {
  const actual = await vi.importActual<ApiClientReactModule>(
    "@workspace/api-client-react",
  );

  const stubbed: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    if (key.startsWith("use") && typeof (actual as Record<string, unknown>)[key] === "function") {
      stubbed[key] = () => makeApiClientHookStub();
    }
  }

  return { ...(stubbed as ApiClientReactModule), ...overrides };
}
