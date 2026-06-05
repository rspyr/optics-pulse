import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetaCampaignBreakdown } from "../MetaCampaignBreakdown";

const metaState = vi.hoisted(() => ({
  summary: { error: "temporary upstream response" } as unknown,
  breakdown: { adSets: { error: "temporary upstream response" } } as unknown,
}));

vi.mock("@workspace/api-client-react", async () => {
  const { mockApiClientReactModule, makeApiClientHookStub } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  return mockApiClientReactModule({
    useGetMetaCampaignSummary: (() => ({
      ...makeApiClientHookStub(),
      data: metaState.summary,
    })) as unknown as typeof import("@workspace/api-client-react").useGetMetaCampaignSummary,
    useGetMetaCampaignBreakdown: (() => ({
      ...makeApiClientHookStub(),
      data: metaState.breakdown,
    })) as unknown as typeof import("@workspace/api-client-react").useGetMetaCampaignBreakdown,
  });
});

describe("MetaCampaignBreakdown partial API responses", () => {
  beforeEach(() => {
    metaState.summary = { error: "temporary upstream response" };
    metaState.breakdown = { adSets: { error: "temporary upstream response" } };
  });

  it("renders an empty state when campaign summary is not an array", () => {
    render(<MetaCampaignBreakdown startDate="2026-06-01" endDate="2026-06-30" />);

    expect(screen.getByText("Meta Campaign Performance")).toBeInTheDocument();
    expect(screen.getByText("No Meta campaigns in this range.")).toBeInTheDocument();
  });

  it("renders an empty state when expanded ad sets are not an array", async () => {
    metaState.summary = [
      {
        campaignId: 42,
        name: "Install Campaign",
        status: "ACTIVE",
        currency: "USD",
        spend: 100,
        clicks: 10,
        conversions: 2,
        cpl: 50,
      },
    ];
    metaState.breakdown = {
      currency: "USD",
      adAccountId: "act_123",
      adSets: { error: "temporary upstream response" },
    };

    render(<MetaCampaignBreakdown startDate="2026-06-01" endDate="2026-06-30" />);
    await userEvent.click(screen.getByTestId("campaign-row-42"));

    expect(screen.getByText("No ad sets with stats in this range.")).toBeInTheDocument();
  });
});
