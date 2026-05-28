import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/components/auth-context", async () => {
  const { mockAuthContextModule, makeAuthStub } = await import(
    "@/test-utils/auth-context-mocks"
  );
  return mockAuthContextModule({
    useAuth: () =>
      makeAuthStub({
        user: { id: 1, role: "agency_admin" } as never,
        isAgency: true,
        selectedTenantId: 1,
        effectiveTenantId: 1,
        tenantSelectionMade: true,
      }),
  });
});

vi.mock("@/hooks/use-push-notifications", async () => {
  const { mockUsePushNotificationsModule } = await import(
    "@/test-utils/use-push-notifications-mocks"
  );
  return mockUsePushNotificationsModule();
});

vi.mock("@/hooks/use-tenants", () => ({
  useTenants: () => ({ tenants: [{ id: 1, name: "Acme" }], tenantsLoading: false }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { mockApiClientReactModule } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  return mockApiClientReactModule();
});

import Settings from "../settings";

type PatchHandler = (url: string, init: RequestInit) => Promise<unknown>;

function installFetch(onPatch: PatchHandler) {
  const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    const u = String(url);
    if (method === "PATCH") {
      return onPatch(u, init || {});
    }
    if (u.includes("/api/leads/comm-config")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            callReady: true,
            textReady: true,
            callStatusMessage: "Ready",
            textStatusMessage: "Ready",
          }),
      });
    }
    if (u.includes("/api/oauth/podium/status")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: false }) });
    }
    if (u.includes("/api/tracker/install-snippet")) {
      // Non-ok keeps TrackerHealthSettings' `data` null so its (unrelated)
      // render branches stay collapsed — this test only cares about the two
      // save cards above it.
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "not relevant to this test" }),
      });
    }
    if (/\/api\/tenants\/\d+$/.test(u)) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            serviceTitanId: "",
            loadableConfig: {},
            revenueConfig: {},
            communicationConfig: { callPlatform: "native", textPlatform: "native" },
          }),
      });
    }
    // Everything else (ingestion-mode, funnel aliases/types, tracker health…)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderSettings() {
  await act(async () => {
    render(<Settings />);
  });
  // Let the on-mount loaders settle so collapsed cards are interactive.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openApiIntegrations() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /API Integrations/ }));
  });
}

async function openCommPlatform() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Communication Platform/ }));
  });
}

function getServiceTitanInput(): HTMLInputElement {
  return screen.getByPlaceholderText("e.g. 123456") as HTMLInputElement;
}

function patchOk() {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
}

describe("Settings — API Integrations save error feedback (handleSave)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the server-provided error message near the Save button on a non-ok { error } response", async () => {
    installFetch(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Invalid ServiceTitan tenant ID" }),
      }),
    );
    await renderSettings();
    await openApiIntegrations();

    fireEvent.change(getServiceTitanInput(), { target: { value: "999" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Configuration/ }));
    });

    const alert = await screen.findByText("Invalid ServiceTitan tenant ID");
    expect(alert).toBeInTheDocument();
    expect(alert.closest('[role="alert"]')).not.toBeNull();
  });

  it("renders a permission message on a 403 with no body", async () => {
    installFetch(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.reject(new Error("no json")),
      }),
    );
    await renderSettings();
    await openApiIntegrations();

    fireEvent.change(getServiceTitanInput(), { target: { value: "555" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Configuration/ }));
    });

    expect(
      await screen.findByText("You don't have permission to modify these settings."),
    ).toBeInTheDocument();
  });

  it("renders a connection error when the request rejects (network failure)", async () => {
    installFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await renderSettings();
    await openApiIntegrations();

    fireEvent.change(getServiceTitanInput(), { target: { value: "777" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Configuration/ }));
    });

    expect(
      await screen.findByText(
        "Couldn't reach the server. Check your connection and try again.",
      ),
    ).toBeInTheDocument();
  });

  it("clears the error when the user edits an integration field again", async () => {
    installFetch(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Invalid ServiceTitan tenant ID" }),
      }),
    );
    await renderSettings();
    await openApiIntegrations();

    fireEvent.change(getServiceTitanInput(), { target: { value: "999" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Configuration/ }));
    });
    expect(await screen.findByText("Invalid ServiceTitan tenant ID")).toBeInTheDocument();

    // Editing serviceTitanId (handleSave field) runs trackField → clears saveError.
    await act(async () => {
      fireEvent.change(getServiceTitanInput(), { target: { value: "1000" } });
    });
    await waitFor(() => {
      expect(screen.queryByText("Invalid ServiceTitan tenant ID")).not.toBeInTheDocument();
    });
  });

  it("clears the error when a different integration field (Google Ads) is edited", async () => {
    installFetch(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Invalid ServiceTitan tenant ID" }),
      }),
    );
    await renderSettings();
    await openApiIntegrations();

    fireEvent.change(getServiceTitanInput(), { target: { value: "999" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Configuration/ }));
    });
    expect(await screen.findByText("Invalid ServiceTitan tenant ID")).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("e.g. 123-456-7890"), {
        target: { value: "123-456-7890" },
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("Invalid ServiceTitan tenant ID")).not.toBeInTheDocument();
    });
  });
});

describe("Settings — Communication Platform save error feedback (handleCommSave)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The "CallRail" / "Podium" labels appear in both the call and text platform
  // columns; index 0 is the call-platform button (rendered first in the DOM).
  function selectCallPlatform(label: string) {
    const btn = screen.getAllByText(label)[0].closest("button");
    if (!btn) throw new Error(`platform button for ${label} not found`);
    fireEvent.click(btn);
  }

  it("renders the server-provided error message near the Save button on a non-ok { error } response", async () => {
    installFetch(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Unsupported platform combination" }),
      }),
    );
    await renderSettings();
    await openCommPlatform();

    await act(async () => {
      selectCallPlatform("CallRail");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Platform Settings/ }));
    });

    const alert = await screen.findByText("Unsupported platform combination");
    expect(alert.closest('[role="alert"]')).not.toBeNull();
  });

  it("renders a permission message on a 403 with no body", async () => {
    installFetch(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.reject(new Error("no json")),
      }),
    );
    await renderSettings();
    await openCommPlatform();

    await act(async () => {
      selectCallPlatform("CallRail");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Platform Settings/ }));
    });

    expect(
      await screen.findByText("You don't have permission to modify these settings."),
    ).toBeInTheDocument();
  });

  it("renders a connection error when the request rejects (network failure)", async () => {
    installFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await renderSettings();
    await openCommPlatform();

    await act(async () => {
      selectCallPlatform("CallRail");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Platform Settings/ }));
    });

    expect(
      await screen.findByText(
        "Couldn't reach the server. Check your connection and try again.",
      ),
    ).toBeInTheDocument();
  });

  it("clears the error when the call/text platform selection changes again", async () => {
    installFetch(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Unsupported platform combination" }),
      }),
    );
    await renderSettings();
    await openCommPlatform();

    await act(async () => {
      selectCallPlatform("CallRail");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Platform Settings/ }));
    });
    expect(await screen.findByText("Unsupported platform combination")).toBeInTheDocument();

    // Changing the platform selection runs setCommError(null).
    await act(async () => {
      selectCallPlatform("Podium");
    });
    await waitFor(() => {
      expect(screen.queryByText("Unsupported platform combination")).not.toBeInTheDocument();
    });
  });
});
