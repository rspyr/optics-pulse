import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Round a money value to whole cents. Money columns are floating-point, so
// summing them in JS can produce sub-cent drift (e.g. 0.1 + 0.2 = 0.30000…04).
// Use this for any client-side aggregation of revenue/rebate values so totals
// never carry spurious precision, matching the API's whole-cent rounding.
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export const PLATFORM_COLORS = {
  google: "#34A853",
  meta: "#1877F2",
  revenue: "#F20505",
  totalCost: "#002D5E",
} as const;

export function formatPercentage(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value / 100);
}
