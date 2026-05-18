import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";

import { AuthProvider, useAuth } from "@/components/auth-context";

const STORAGE_KEY = "agencyGodView.tenantId";

function Probe({ onReady }: { onReady: (auth: ReturnType<typeof useAuth>) => void }) {
  const auth = useAuth();
  React.useEffect(() => {
    onReady(auth);
  });
  return null;
}

function mount() {
  let latest: ReturnType<typeof useAuth> | null = null;
  render(
    <AuthProvider>
      <Probe onReady={(a) => { latest = a; }} />
    </AuthProvider>,
  );
  return () => {
    if (!latest) throw new Error("auth not ready");
    return latest;
  };
}

describe("AuthContext — Agency God View tenant filter persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve(null) }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("treats missing storage as 'no choice made'", () => {
    const get = mount();
    const a = get();
    expect(a.selectedTenantId).toBeNull();
    expect(a.tenantSelectionMade).toBe(false);
  });

  it("reads a numeric tenant id from storage as an explicit choice", () => {
    window.localStorage.setItem(STORAGE_KEY, "42");
    const a = mount()();
    expect(a.selectedTenantId).toBe(42);
    expect(a.tenantSelectionMade).toBe(true);
  });

  it("reads the 'all' sentinel as an explicit All Tenants choice", () => {
    window.localStorage.setItem(STORAGE_KEY, "all");
    const a = mount()();
    expect(a.selectedTenantId).toBeNull();
    expect(a.tenantSelectionMade).toBe(true);
  });

  it("treats malformed values as no choice made", () => {
    window.localStorage.setItem(STORAGE_KEY, "garbage");
    const a = mount()();
    expect(a.selectedTenantId).toBeNull();
    expect(a.tenantSelectionMade).toBe(false);
  });

  it("treats zero or negative ids as malformed", () => {
    window.localStorage.setItem(STORAGE_KEY, "0");
    let a = mount()();
    expect(a.selectedTenantId).toBeNull();
    expect(a.tenantSelectionMade).toBe(false);

    window.localStorage.setItem(STORAGE_KEY, "-3");
    a = mount()();
    expect(a.selectedTenantId).toBeNull();
    expect(a.tenantSelectionMade).toBe(false);
  });

  it("writes a numeric id when a tenant is picked", () => {
    const get = mount();
    act(() => { get().setSelectedTenantId(7); });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("7");
    expect(get().selectedTenantId).toBe(7);
    expect(get().tenantSelectionMade).toBe(true);
  });

  it("writes the 'all' sentinel when All Tenants is picked", () => {
    const get = mount();
    act(() => { get().setSelectedTenantId(null); });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("all");
    expect(get().selectedTenantId).toBeNull();
    expect(get().tenantSelectionMade).toBe(true);
  });

  it("round-trips the choice across a fresh mount (simulated reload)", () => {
    const get = mount()
    act(() => { get().setSelectedTenantId(99); });

    // Tear down + remount = page reload
    const get2 = mount();
    expect(get2().selectedTenantId).toBe(99);
    expect(get2().tenantSelectionMade).toBe(true);
  });

  it("round-trips an explicit All Tenants choice across reload", () => {
    const get = mount();
    act(() => { get().setSelectedTenantId(null); });
    const get2 = mount();
    expect(get2().selectedTenantId).toBeNull();
    expect(get2().tenantSelectionMade).toBe(true);
  });
});
