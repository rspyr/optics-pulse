import { describe, it, expect } from "vitest";
import {
  isRebateLineItem,
  parseEstimateData,
  parseInvoiceData,
  compileRebatePattern,
  compileRebatePatterns,
  DEFAULT_REBATE_LABELS,
  REBATE_LABEL_PATTERNS,
  type STEstimate,
  type STEstimateItem,
  type STInvoice,
  type STInvoiceItem,
} from "./service-titan";

function estimateItem(overrides: Partial<STEstimateItem>): STEstimateItem {
  return {
    id: 1,
    description: "",
    quantity: 1,
    unitPrice: 0,
    total: 0,
    type: "Service",
    ...overrides,
  };
}

function estimate(items: STEstimateItem[], subtotal: number): STEstimate {
  return {
    id: 1001,
    jobId: 2002,
    name: "Test Estimate",
    status: { name: "Sold", value: 2 },
    summary: "Install option",
    followUpOn: "2026-01-20T00:00:00Z",
    soldBy: 42,
    soldOn: "2026-01-15T00:00:00Z",
    subtotal,
    total: subtotal,
    items,
    modifiedOn: "2026-01-15T00:00:00Z",
    active: true,
  };
}

function invoiceItem(overrides: Partial<STInvoiceItem>): STInvoiceItem {
  return {
    id: 1,
    description: "",
    quantity: "1",
    price: "0",
    total: "0",
    type: "Service",
    skuName: "",
    ...overrides,
  };
}

function invoice(items: STInvoiceItem[], total: number, balance = 0): STInvoice {
  return {
    id: 3003,
    total: String(total),
    balance: String(balance),
    invoiceDate: "2026-01-15T00:00:00Z",
    paidOn: null,
    job: { id: 2002, number: "J-1", type: "Service" },
    items,
    active: true,
  };
}

describe("isRebateLineItem (default patterns)", () => {
  it("matches ETO (Energy Trust of Oregon) labels", () => {
    expect(isRebateLineItem(["ETO Rebate"])).toBe(true);
    expect(isRebateLineItem(["eto credit"])).toBe(true);
    expect(isRebateLineItem(["Energy Trust rebate"])).toBe(true);
    expect(isRebateLineItem(["Energy  Trust of Oregon"])).toBe(true);
  });

  it("matches ODEE labels", () => {
    expect(isRebateLineItem(["ODEE Rebate"])).toBe(true);
    expect(isRebateLineItem(["odee incentive"])).toBe(true);
  });

  it("matches when any of multiple labels matches (description or SKU)", () => {
    expect(isRebateLineItem(["Generic line", "ETO Rebate SKU"])).toBe(true);
    expect(isRebateLineItem([null, "ODEE"])).toBe(true);
    expect(isRebateLineItem([undefined, "energy trust"])).toBe(true);
  });

  it("does NOT match generic discounts/coupons", () => {
    expect(isRebateLineItem(["Discount"])).toBe(false);
    expect(isRebateLineItem(["Coupon"])).toBe(false);
    expect(isRebateLineItem(["Senior Discount"])).toBe(false);
    expect(isRebateLineItem(["Promo code"])).toBe(false);
    expect(isRebateLineItem(["$50 off"])).toBe(false);
  });

  it("does NOT match on partial/embedded word collisions", () => {
    expect(isRebateLineItem(["Veto power adjustment"])).toBe(false);
    expect(isRebateLineItem(["Metodee service"])).toBe(false);
  });

  it("returns false for empty/blank/nullish input", () => {
    expect(isRebateLineItem([])).toBe(false);
    expect(isRebateLineItem([null])).toBe(false);
    expect(isRebateLineItem([undefined])).toBe(false);
    expect(isRebateLineItem([""])).toBe(false);
    expect(isRebateLineItem(["   "])).toBe(false);
  });
});

describe("compileRebatePattern / compileRebatePatterns", () => {
  it("compiles a plain label into a case-insensitive, word-boundary regex", () => {
    const pattern = compileRebatePattern("ETO");
    expect(pattern).not.toBeNull();
    expect(pattern!.test("ETO Rebate")).toBe(true);
    expect(pattern!.test("eto credit")).toBe(true);
    expect(pattern!.test("Veto power")).toBe(false);
  });

  it("allows flexible internal whitespace for multi-word labels", () => {
    const pattern = compileRebatePattern("Energy Trust")!;
    expect(pattern.test("Energy Trust")).toBe(true);
    expect(pattern.test("Energy  Trust of Oregon")).toBe(true);
    expect(pattern.test("EnergyTrust")).toBe(true);
  });

  it("escapes regex special characters so they are matched literally", () => {
    const pattern = compileRebatePattern("PGE+ Rebate")!;
    expect(pattern.test("PGE+ Rebate applied")).toBe(true);
    expect(pattern.test("PGEEEE Rebate")).toBe(false);
  });

  it("returns null for blank labels and drops them from the list", () => {
    expect(compileRebatePattern("")).toBeNull();
    expect(compileRebatePattern("   ")).toBeNull();
    expect(compileRebatePatterns(["ETO", "", "  ", "ODEE"])).toHaveLength(2);
  });

  it("the seeded defaults compile from DEFAULT_REBATE_LABELS", () => {
    expect(DEFAULT_REBATE_LABELS).toEqual(["ETO", "Energy Trust", "ODEE"]);
    expect(REBATE_LABEL_PATTERNS).toHaveLength(3);
    expect(isRebateLineItem(["ETO Rebate"], REBATE_LABEL_PATTERNS)).toBe(true);
  });
});

describe("isRebateLineItem (custom configurable patterns)", () => {
  it("matches a newly configured rebate program that defaults would miss", () => {
    const custom = compileRebatePatterns(["PGE Rebate", "Avista"]);
    expect(isRebateLineItem(["PGE Rebate"], custom)).toBe(true);
    expect(isRebateLineItem(["Avista incentive"], custom)).toBe(true);
    // ETO is not in the custom list, so it should NOT match anymore.
    expect(isRebateLineItem(["ETO Rebate"], custom)).toBe(false);
  });

  it("treats an empty pattern list as 'no rebates'", () => {
    expect(isRebateLineItem(["ETO Rebate"], [])).toBe(false);
    expect(isRebateLineItem(["Energy Trust"], [])).toBe(false);
  });
});

describe("parseEstimateData", () => {
  it("adds back only ETO/ODEE rebate items, not generic discounts", () => {
    const est = estimate(
      [
        estimateItem({ id: 1, description: "HVAC Install", total: 1000 }),
        estimateItem({ id: 2, description: "ETO Rebate", total: -200 }),
        estimateItem({ id: 3, description: "ODEE Rebate", total: -100 }),
        estimateItem({ id: 4, description: "Senior Discount", total: -50 }),
        estimateItem({ id: 5, skuName: "Energy Trust Credit", total: -75 }),
      ],
      // subtotal is ST's total with rebates AND discount already subtracted:
      // 1000 - 200 - 100 - 50 - 75 = 575
      575,
    );

    const result = parseEstimateData(est);

    // Only the three rebate items add back: 200 + 100 + 75 = 375
    expect(result.rebateAmount).toBe(375);
    expect(result.rebateBreakdown).toEqual([
      { label: "ETO Rebate", amount: 200 },
      { label: "ODEE Rebate", amount: 100 },
      { label: "Energy Trust Credit", amount: 75 },
    ]);
    // The genuine discount stays subtracted: 575 + 375 = 950
    expect(result.totalAmount).toBe(950);
    expect(result.subtotal).toBe(575);
    expect(result.estimateName).toBe("Test Estimate");
    expect(result.estimateStatus).toBe("Sold");
    expect(result.summary).toBe("Install option");
    expect(result.followUpOn).toEqual(new Date("2026-01-20T00:00:00Z"));
  });

  it("prefers skuName as the breakdown label when present", () => {
    const est = estimate(
      [estimateItem({ id: 1, description: "ETO line", skuName: "ETO-2024", total: -120 })],
      -120,
    );
    const result = parseEstimateData(est);
    expect(result.rebateBreakdown).toEqual([{ label: "ETO-2024", amount: 120 }]);
  });

  it("ignores positive items matching rebate words and ignores positive-total rebate lines", () => {
    const est = estimate(
      [
        estimateItem({ id: 1, description: "ETO consultation fee", total: 150 }),
        estimateItem({ id: 2, description: "Service", total: 500 }),
      ],
      650,
    );
    const result = parseEstimateData(est);
    expect(result.rebateAmount).toBe(0);
    expect(result.rebateBreakdown).toEqual([]);
    expect(result.totalAmount).toBe(650);
  });

  it("returns zero rebate when there are only discounts", () => {
    const est = estimate(
      [
        estimateItem({ id: 1, description: "Service", total: 800 }),
        estimateItem({ id: 2, description: "Coupon", total: -100 }),
      ],
      700,
    );
    const result = parseEstimateData(est);
    expect(result.rebateAmount).toBe(0);
    expect(result.rebateBreakdown).toEqual([]);
    expect(result.totalAmount).toBe(700);
  });

  it("handles missing items array", () => {
    const est = estimate([], 300);
    est.items = undefined as unknown as STEstimateItem[];
    const result = parseEstimateData(est);
    expect(result.rebateAmount).toBe(0);
    expect(result.totalAmount).toBe(300);
  });
});

describe("parseInvoiceData", () => {
  it("adds back only ETO/ODEE rebate items, not generic discounts", () => {
    const inv = invoice(
      [
        invoiceItem({ id: 1, description: "HVAC Install", total: "1000" }),
        invoiceItem({ id: 2, description: "ETO Rebate", total: "-200" }),
        invoiceItem({ id: 3, skuName: "ODEE Credit", total: "-100" }),
        invoiceItem({ id: 4, description: "Senior Discount", total: "-50" }),
      ],
      // ST invoice total already nets rebates + discount: 1000-200-100-50 = 650
      650,
    );

    const result = parseInvoiceData(inv);

    // Only rebate items: 200 + 100 = 300
    expect(result.invoiceRebateAmount).toBe(300);
    expect(result.invoiceRebateBreakdown).toEqual([
      { label: "ETO Rebate", amount: 200 },
      { label: "ODEE Credit", amount: 100 },
    ]);
    expect(result.invoiceTotal).toBe(650);
  });

  it("returns zero rebate when there are only discounts", () => {
    const inv = invoice(
      [
        invoiceItem({ id: 1, description: "Service", total: "500" }),
        invoiceItem({ id: 2, description: "Discount", total: "-75" }),
      ],
      425,
    );
    const result = parseInvoiceData(inv);
    expect(result.invoiceRebateAmount).toBe(0);
    expect(result.invoiceRebateBreakdown).toEqual([]);
  });

  it("ignores positive-total items even if they match rebate words", () => {
    const inv = invoice(
      [invoiceItem({ id: 1, description: "ETO inspection", total: "150" })],
      150,
    );
    const result = parseInvoiceData(inv);
    expect(result.invoiceRebateAmount).toBe(0);
    expect(result.invoiceRebateBreakdown).toEqual([]);
  });

  it("computes paidAmount as total minus balance, clamped at zero", () => {
    const inv = invoice([invoiceItem({ id: 1, total: "500" })], 500, 200);
    const result = parseInvoiceData(inv);
    expect(result.invoicePaidAmount).toBe(300);

    const overpaid = invoice([invoiceItem({ id: 1, total: "500" })], 500, 600);
    expect(parseInvoiceData(overpaid).invoicePaidAmount).toBe(0);
  });

  it("handles missing items array", () => {
    const inv = invoice([], 300);
    inv.items = undefined as unknown as STInvoiceItem[];
    const result = parseInvoiceData(inv);
    expect(result.invoiceRebateAmount).toBe(0);
    expect(result.invoiceRebateBreakdown).toEqual([]);
  });
});
