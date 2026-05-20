# marketing-os test utilities

These helpers wrap `vi.mock` factories for the modules that the marketing-os
test suite mocks most often. **Use them whenever you need to mock one of these
modules from a new test** — don't hand-roll a partial `vi.mock` factory.

## Why

A plain `vi.mock("@/foo", () => ({ ... }))` factory returns an `unknown`-typed
object. When the underlying module grows a new export — a new hook, a new
context field — vitest happily lets the test keep "passing" while every
consumer that reads the new export sees `undefined`. The bug only surfaces in
the browser, sometimes weeks later.

The helpers here make that drift a **compile error** instead:

- `mockXxxModule(overrides)` is typed as
  `Partial<typeof import("@/path/to/module")>`, and the helper returns the
  full module shape. Adding (or renaming, or removing) an export on the real
  module surfaces a typescript error at the helper definition until it's
  updated — and an error at the call site if a test tries to override
  something that no longer exists.
- `makeXxxStub(overrides)` is typed as the real return type of the
  hook/context (e.g. `ReturnType<typeof useAuth>`). Adding a new field on the
  context value surfaces a typescript error at the helper — once you add a
  default there, every existing test inherits it automatically.

## Available helpers

| File | Mocks | When to use |
| --- | --- | --- |
| `api-client-react-mocks.ts` | `@workspace/api-client-react` | Any test that imports a generated react-query hook from the API client. Auto-stubs every `use*` hook with a safe no-op so unrelated hooks don't fire real fetches. |
| `lead-notification-mocks.ts` | `@/contexts/lead-notification-context` | Tests that mount a tree containing `<LeadNotificationProvider>` but don't care about its socket behavior. |
| `auth-context-mocks.ts` | `@/components/auth-context` | Tests that mount a tree using `useAuth()` but don't care about the real `/api/auth/me` fetch. |
| `use-tenant-filter-mocks.ts` | `@/hooks/use-tenant-filter` | Tests that render a page reading the tenant-scope filter but don't care about driving its react-query / persistence wiring. |
| `ui-select-mocks.ts` | `@/components/ui/select` | Tests that drive Radix `Select` via `fireEvent.change` — jsdom can't model the popover, so swap it for a native `<select>`. |

## Pattern

```ts
// Top of the test file, before importing anything that reads the mocked module:
vi.mock("@/components/auth-context", async () => {
  const { mockAuthContextModule, makeAuthStub } = await import(
    "@/test-utils/auth-context-mocks",
  );
  return mockAuthContextModule({
    // Only the things THIS test cares about — everything else falls back to
    // safe defaults from the helper.
    useAuth: () => makeAuthStub({ effectiveTenantId: 42 }),
  });
});
```

Three rules of thumb:

1. **Always go through the helper.** A bare `vi.mock("@/components/auth-context", () => ({ useAuth: () => ({ ... }) }))` is the bug we're trying to prevent — the inline object isn't pinned to the real context value type, so a missing field silently returns `undefined`.
2. **Override the minimum.** Anything you don't pass falls back to the helper's safe default. That means a new field added to the underlying module only requires one edit (the helper) instead of N (every test).
3. **If you need a helper for a new module, add one here.** Use the existing helpers as templates. The two pieces you need are: (a) a `makeXxxStub` returning the real return type of the hook/context with safe defaults, and (b) a `mockXxxModule(overrides: Partial<Module>)` returning the full module shape.
