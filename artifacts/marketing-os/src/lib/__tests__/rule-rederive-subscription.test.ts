import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RuleRederiveCompleteData } from "@/contexts/lead-notification-context";
import {
  formatRederiveMessage,
  subscribeRederiveOnce,
  type SubscribeRuleRederiveComplete,
} from "../rule-rederive-subscription";

describe("formatRederiveMessage", () => {
  it("returns null when leadsChanged is 0", () => {
    expect(
      formatRederiveMessage({ leadsChanged: 0, hitLimit: false, maxLeads: 100 }),
    ).toBeNull();
  });

  it("returns null when leadsChanged is negative", () => {
    expect(
      formatRederiveMessage({ leadsChanged: -5, hitLimit: false, maxLeads: 100 }),
    ).toBeNull();
  });

  it("renders singular form for exactly 1 lead", () => {
    expect(
      formatRederiveMessage({ leadsChanged: 1, hitLimit: false, maxLeads: 100 }),
    ).toBe("1 historical lead re-derived");
  });

  it("renders plural form for >1 leads", () => {
    expect(
      formatRederiveMessage({ leadsChanged: 12, hitLimit: false, maxLeads: 100 }),
    ).toBe("12 historical leads re-derived");
  });

  it("appends capped suffix when hitLimit is true (plural)", () => {
    expect(
      formatRederiveMessage({ leadsChanged: 100, hitLimit: true, maxLeads: 100 }),
    ).toBe("100+ (capped at 100) historical leads re-derived");
  });

  it("appends capped suffix when hitLimit is true (singular)", () => {
    expect(
      formatRederiveMessage({ leadsChanged: 1, hitLimit: true, maxLeads: 1 }),
    ).toBe("1+ (capped at 1) historical lead re-derived");
  });
});

describe("subscribeRederiveOnce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSubscribe(): {
    subscribe: SubscribeRuleRederiveComplete;
    emit: (data: RuleRederiveCompleteData) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  } {
    const callbacks: Array<(data: RuleRederiveCompleteData) => void> = [];
    const unsubscribe = vi.fn();
    const subscribe: SubscribeRuleRederiveComplete = (cb) => {
      callbacks.push(cb);
      return () => {
        unsubscribe();
      };
    };
    return {
      subscribe,
      emit: (data) => callbacks.forEach((cb) => cb(data)),
      unsubscribe,
    };
  }

  it("calls onMessage and onSettled when a matching event arrives", () => {
    const { subscribe, emit, unsubscribe } = makeSubscribe();
    const onMessage = vi.fn();
    const onSettled = vi.fn();

    subscribeRederiveOnce(subscribe, 7, "/pricing", "form-a", onMessage, onSettled);

    emit({
      tenantId: 7,
      pageUrlPattern: "/pricing",
      formIdentifier: "form-a",
      leadsChanged: 3,
      hitLimit: false,
      maxLeads: 100,
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith("3 historical leads re-derived");
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("ignores events with a different tenantId", () => {
    const { subscribe, emit } = makeSubscribe();
    const onMessage = vi.fn();
    const onSettled = vi.fn();

    subscribeRederiveOnce(subscribe, 7, "/pricing", "form-a", onMessage, onSettled);

    emit({
      tenantId: 99,
      pageUrlPattern: "/pricing",
      formIdentifier: "form-a",
      leadsChanged: 3,
      hitLimit: false,
      maxLeads: 100,
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("ignores events with a different pageUrlPattern", () => {
    const { subscribe, emit } = makeSubscribe();
    const onMessage = vi.fn();
    const onSettled = vi.fn();

    subscribeRederiveOnce(subscribe, 7, "/pricing", "form-a", onMessage, onSettled);

    emit({
      tenantId: 7,
      pageUrlPattern: "/other",
      formIdentifier: "form-a",
      leadsChanged: 3,
      hitLimit: false,
      maxLeads: 100,
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("ignores events with a different formIdentifier", () => {
    const { subscribe, emit } = makeSubscribe();
    const onMessage = vi.fn();
    const onSettled = vi.fn();

    subscribeRederiveOnce(subscribe, 7, "/pricing", "form-a", onMessage, onSettled);

    emit({
      tenantId: 7,
      pageUrlPattern: "/pricing",
      formIdentifier: "form-b",
      leadsChanged: 3,
      hitLimit: false,
      maxLeads: 100,
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("does not call onMessage when leadsChanged is 0, but still settles", () => {
    const { subscribe, emit, unsubscribe } = makeSubscribe();
    const onMessage = vi.fn();
    const onSettled = vi.fn();

    subscribeRederiveOnce(subscribe, 7, "/pricing", "form-a", onMessage, onSettled);

    emit({
      tenantId: 7,
      pageUrlPattern: "/pricing",
      formIdentifier: "form-a",
      leadsChanged: 0,
      hitLimit: false,
      maxLeads: 100,
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("calls onSettled synchronously and returns a no-op when subscribe is null", () => {
    const onMessage = vi.fn();
    const onSettled = vi.fn();

    const unsub = subscribeRederiveOnce(null, 7, "/pricing", "form-a", onMessage, onSettled);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
    expect(() => unsub()).not.toThrow();
  });

  it("does not throw when subscribe is null and no onSettled is provided", () => {
    const onMessage = vi.fn();
    expect(() =>
      subscribeRederiveOnce(null, 7, "/pricing", "form-a", onMessage),
    ).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("cleans up after a 30s timeout if no event arrives", () => {
    const { subscribe, unsubscribe } = makeSubscribe();
    const onMessage = vi.fn();
    const onSettled = vi.fn();

    subscribeRederiveOnce(subscribe, 7, "/pricing", "form-a", onMessage, onSettled);

    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(29_999);
    expect(onSettled).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores events that arrive after the timeout fired", () => {
    const { subscribe, emit } = makeSubscribe();
    const onMessage = vi.fn();
    const onSettled = vi.fn();

    subscribeRederiveOnce(subscribe, 7, "/pricing", "form-a", onMessage, onSettled);

    vi.advanceTimersByTime(30_000);
    expect(onSettled).toHaveBeenCalledTimes(1);

    emit({
      tenantId: 7,
      pageUrlPattern: "/pricing",
      formIdentifier: "form-a",
      leadsChanged: 5,
      hitLimit: false,
      maxLeads: 100,
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("returned unsubscribe cleans up and settles, and is idempotent", () => {
    const { subscribe, unsubscribe } = makeSubscribe();
    const onMessage = vi.fn();
    const onSettled = vi.fn();

    const cleanup = subscribeRederiveOnce(
      subscribe,
      7,
      "/pricing",
      "form-a",
      onMessage,
      onSettled,
    );

    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);

    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("matches when tenantId is omitted on the incoming event", () => {
    const { subscribe, emit } = makeSubscribe();
    const onMessage = vi.fn();

    subscribeRederiveOnce(subscribe, 7, "/pricing", "form-a", onMessage);

    emit({
      pageUrlPattern: "/pricing",
      formIdentifier: "form-a",
      leadsChanged: 2,
      hitLimit: false,
      maxLeads: 100,
    });

    expect(onMessage).toHaveBeenCalledWith("2 historical leads re-derived");
  });
});
