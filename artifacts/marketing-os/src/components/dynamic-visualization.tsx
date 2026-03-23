import { useRef, useEffect, useMemo } from "react";
import { reactive, html } from "@arrow-js/core";

interface DynamicVisualizationProps {
  data: Record<string, unknown>[];
  chartType: string;
  chartLabel?: string;
}

export function DynamicVisualization({ data, chartType, chartLabel }: DynamicVisualizationProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const vizConfig = useMemo(() => {
    if (!data || data.length === 0) return null;
    return { data, chartType, chartLabel };
  }, [data, chartType, chartLabel]);

  useEffect(() => {
    if (!containerRef.current || !vizConfig) return;

    const el = containerRef.current;
    el.innerHTML = "";

    const state = reactive({
      data: vizConfig.data,
      chartType: vizConfig.chartType,
      label: vizConfig.chartLabel || "",
      hoveredIndex: -1,
    });

    const type = vizConfig.chartType;
    const rows = vizConfig.data;
    const keys = Object.keys(rows[0] || {});

    if (type === "number") {
      renderKPICard(el, state, rows, keys);
    } else if (type === "bar" || type === "horizontal-bar") {
      renderBarChart(el, state, rows, keys);
    } else if (type === "trend-line") {
      renderTrendLine(el, state, rows, keys);
    } else if (type === "pie") {
      renderPieChart(el, state, rows, keys);
    } else if (type === "list") {
      renderList(el, state, rows, keys);
    } else {
      renderTable(el, state, rows, keys);
    }

    return () => {
      el.innerHTML = "";
    };
  }, [vizConfig]);

  if (!data || data.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="mt-3 arrow-viz"
    />
  );
}

function renderKPICard(
  container: HTMLElement,
  state: any,
  rows: Record<string, unknown>[],
  keys: string[]
) {
  const row = rows[0];
  const entries = keys.map((k) => ({ label: formatLabel(k), value: formatValue(row[k]) }));

  const primary = entries[0];
  const secondary = entries.slice(1);

  const tpl = html`
    <div style="background: linear-gradient(135deg, rgba(59,130,246,0.1), rgba(139,92,246,0.1)); border-radius: 12px; padding: 16px; border: 1px solid rgba(255,255,255,0.08);">
      <div style="text-center">
        <div style="font-size: 28px; font-weight: 700; color: white; letter-spacing: -0.5px;">
          ${primary?.value || "N/A"}
        </div>
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.5); margin-top: 4px;">
          ${primary?.label || ""}
        </div>
      </div>
      ${secondary.length > 0 ? html`
        <div style="display: grid; grid-template-columns: repeat(${Math.min(secondary.length, 3)}, 1fr); gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.08);">
          ${secondary.map((e) => html`
            <div style="text-align: center;">
              <div style="font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.9);">${e.value}</div>
              <div style="font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase;">${e.label}</div>
            </div>
          `)}
        </div>
      ` : html``}
    </div>
  `;
  tpl(container);
}

function renderBarChart(
  container: HTMLElement,
  state: any,
  rows: Record<string, unknown>[],
  keys: string[]
) {
  const nameKey = keys[0];
  const numericKeys = keys.filter((k) => k !== nameKey && isNumeric(rows[0]?.[k]));
  const valueKey = numericKeys[0] || keys[1];
  const maxVal = Math.max(...rows.map((d) => Math.abs(Number(d[valueKey]) || 0)), 1);

  const bars = rows.slice(0, 12).map((row, i) => ({
    name: String(row[nameKey] || ""),
    value: Number(row[valueKey]) || 0,
    pct: (Math.abs(Number(row[valueKey]) || 0) / maxVal) * 100,
    index: i,
  }));

  const label = state.label || formatLabel(valueKey);

  const tpl = html`
    <div>
      <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.4); margin-bottom: 8px;">${label}</div>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${bars.map((bar) => html`
          <div style="display: flex; align-items: center; gap: 8px; font-size: 12px;">
            <span style="color: rgba(255,255,255,0.6); width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;" title="${bar.name}">${bar.name}</span>
            <div style="flex: 1; height: 18px; background: rgba(255,255,255,0.04); border-radius: 4px; overflow: hidden; position: relative;">
              <div style="height: 100%; width: ${bar.pct}%; background: linear-gradient(90deg, rgba(59,130,246,0.5), rgba(139,92,246,0.5)); border-radius: 4px; transition: width 0.4s ease-out;"></div>
            </div>
            <span style="color: rgba(255,255,255,0.8); width: 60px; text-align: right; flex-shrink: 0;">${formatValue(bar.value)}</span>
          </div>
        `)}
      </div>
      ${rows.length > 12 ? html`<div style="font-size: 10px; color: rgba(255,255,255,0.3); margin-top: 6px;">Showing 12 of ${rows.length} items</div>` : html``}
    </div>
  `;
  tpl(container);
}

function renderTrendLine(
  container: HTMLElement,
  state: any,
  rows: Record<string, unknown>[],
  keys: string[]
) {
  const dateKey = keys.find((k) => k.toLowerCase().includes("date")) || keys[0];
  const numericKeys = keys.filter((k) => k !== dateKey && isNumeric(rows[0]?.[k]));
  const valueKey = numericKeys[0] || keys[1];

  const sorted = [...rows].sort((a, b) => String(a[dateKey] || "").localeCompare(String(b[dateKey] || "")));
  const points = sorted.slice(0, 60);
  const values = points.map((p) => Number(p[valueKey]) || 0);
  const maxVal = Math.max(...values, 1);
  const minVal = Math.min(...values, 0);
  const range = maxVal - minVal || 1;

  const svgWidth = 380;
  const svgHeight = 120;
  const padding = 20;
  const chartW = svgWidth - padding * 2;
  const chartH = svgHeight - padding * 2;

  const pathPoints = points.map((_, i) => {
    const x = padding + (i / Math.max(points.length - 1, 1)) * chartW;
    const y = padding + chartH - ((values[i] - minVal) / range) * chartH;
    return `${x},${y}`;
  });
  const linePath = `M${pathPoints.join(" L")}`;
  const areaPath = `${linePath} L${padding + chartW},${padding + chartH} L${padding},${padding + chartH} Z`;

  const label = state.label || formatLabel(valueKey);

  const tpl = html`
    <div>
      <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.4); margin-bottom: 8px;">${label}</div>
      <svg width="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" style="overflow: visible;">
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(59,130,246,0.3)" />
            <stop offset="100%" stop-color="rgba(59,130,246,0)" />
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#areaGrad)" />
        <path d="${linePath}" fill="none" stroke="rgba(59,130,246,0.8)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        ${points.length > 0 ? html`
          <circle cx="${padding}" cy="${padding + chartH - ((values[0] - minVal) / range) * chartH}" r="3" fill="rgba(59,130,246,0.8)" />
          <circle cx="${padding + chartW}" cy="${padding + chartH - ((values[values.length - 1] - minVal) / range) * chartH}" r="3" fill="rgba(59,130,246,0.8)" />
        ` : html``}
        <text x="${padding}" y="${svgHeight - 2}" fill="rgba(255,255,255,0.3)" font-size="9">${formatDateShort(String(points[0]?.[dateKey] || ""))}</text>
        <text x="${svgWidth - padding}" y="${svgHeight - 2}" fill="rgba(255,255,255,0.3)" font-size="9" text-anchor="end">${formatDateShort(String(points[points.length - 1]?.[dateKey] || ""))}</text>
        <text x="${padding}" y="${padding - 4}" fill="rgba(255,255,255,0.3)" font-size="9">${formatValue(maxVal)}</text>
      </svg>
    </div>
  `;
  tpl(container);
}

function renderPieChart(
  container: HTMLElement,
  state: any,
  rows: Record<string, unknown>[],
  keys: string[]
) {
  const nameKey = keys[0];
  const numericKeys = keys.filter((k) => k !== nameKey && isNumeric(rows[0]?.[k]));
  const valueKey = numericKeys[0] || keys[1];

  const slices = rows.slice(0, 8).map((row) => ({
    name: String(row[nameKey] || ""),
    value: Math.abs(Number(row[valueKey]) || 0),
  }));
  const total = slices.reduce((s, d) => s + d.value, 0) || 1;

  const colors = [
    "rgba(59,130,246,0.7)", "rgba(139,92,246,0.7)", "rgba(16,185,129,0.7)",
    "rgba(245,158,11,0.7)", "rgba(239,68,68,0.7)", "rgba(99,102,241,0.7)",
    "rgba(236,72,153,0.7)", "rgba(20,184,166,0.7)",
  ];

  const label = state.label || formatLabel(valueKey);

  const legendItems = slices.map((s, i) => ({
    name: s.name,
    pct: ((s.value / total) * 100).toFixed(1),
    color: colors[i % colors.length],
    value: formatValue(s.value),
  }));

  const tpl = html`
    <div>
      <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.4); margin-bottom: 8px;">${label}</div>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${legendItems.map((item) => html`
          <div style="display: flex; align-items: center; gap: 8px; font-size: 12px;">
            <span style="width: 10px; height: 10px; border-radius: 2px; background: ${item.color}; flex-shrink: 0;"></span>
            <span style="color: rgba(255,255,255,0.7); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.name}</span>
            <span style="color: rgba(255,255,255,0.5);">${item.pct}%</span>
            <span style="color: rgba(255,255,255,0.8); width: 50px; text-align: right;">${item.value}</span>
          </div>
        `)}
      </div>
    </div>
  `;
  tpl(container);
}

function renderList(
  container: HTMLElement,
  state: any,
  rows: Record<string, unknown>[],
  keys: string[]
) {
  const titleKey = keys.find((k) => ["title", "name", "question", "reason"].includes(k.toLowerCase())) || keys[0];
  const subtitleKey = keys.find((k) => ["description", "body", "notes", "category"].includes(k.toLowerCase()));
  const dateKey = keys.find((k) => k.toLowerCase().includes("date") || k.toLowerCase().includes("at"));

  const label = state.label || "";

  const items = rows.slice(0, 15).map((row) => ({
    title: String(row[titleKey] || ""),
    subtitle: subtitleKey ? String(row[subtitleKey] || "") : "",
    date: dateKey ? formatDateShort(String(row[dateKey] || "")) : "",
  }));

  const tpl = html`
    <div>
      ${label ? html`<div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.4); margin-bottom: 8px;">${label}</div>` : html``}
      <div style="display: flex; flex-direction: column; gap: 4px;">
        ${items.map((item) => html`
          <div style="padding: 8px 10px; background: rgba(255,255,255,0.03); border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
            <div style="display: flex; justify-content: space-between; align-items: start;">
              <span style="font-size: 12px; color: rgba(255,255,255,0.85); font-weight: 500;">${item.title}</span>
              ${item.date ? html`<span style="font-size: 10px; color: rgba(255,255,255,0.35); flex-shrink: 0; margin-left: 8px;">${item.date}</span>` : html``}
            </div>
            ${item.subtitle ? html`<div style="font-size: 11px; color: rgba(255,255,255,0.45); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.subtitle}</div>` : html``}
          </div>
        `)}
      </div>
      ${rows.length > 15 ? html`<div style="font-size: 10px; color: rgba(255,255,255,0.3); margin-top: 6px;">Showing 15 of ${rows.length} items</div>` : html``}
    </div>
  `;
  tpl(container);
}

function renderTable(
  container: HTMLElement,
  state: any,
  rows: Record<string, unknown>[],
  keys: string[]
) {
  const visibleKeys = keys.slice(0, 6);
  const displayRows = rows.slice(0, 15);
  const label = state.label || "";

  const tpl = html`
    <div style="overflow-x: auto;">
      ${label ? html`<div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.4); margin-bottom: 6px;">${label}</div>` : html``}
      <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
        <thead>
          <tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
            ${visibleKeys.map((k) => html`
              <th style="text-align: left; padding: 6px; color: rgba(255,255,255,0.5); font-weight: 500; text-transform: capitalize; font-size: 11px;">${formatLabel(k)}</th>
            `)}
          </tr>
        </thead>
        <tbody>
          ${displayRows.map((row) => html`
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.04);">
              ${visibleKeys.map((k) => html`
                <td style="padding: 6px; color: rgba(255,255,255,0.75);">${formatValue(row[k])}</td>
              `)}
            </tr>
          `)}
        </tbody>
      </table>
      ${rows.length > 15 ? html`<div style="font-size: 10px; color: rgba(255,255,255,0.3); margin-top: 6px;">Showing 15 of ${rows.length} rows</div>` : html``}
    </div>
  `;
  tpl(container);
}

function formatLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "number") {
    if (Math.abs(val) >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
    if (Math.abs(val) >= 1000) return `${(val / 1000).toFixed(1)}K`;
    if (val % 1 !== 0) return val.toFixed(2);
    return String(val);
  }
  if (typeof val === "boolean") return val ? "Yes" : "No";
  const s = String(val);
  if (s.length > 50) return s.slice(0, 47) + "...";
  return s;
}

function formatDateShort(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr.slice(0, 10);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return dateStr.slice(0, 10);
  }
}

function isNumeric(val: unknown): boolean {
  return typeof val === "number" || (typeof val === "string" && !isNaN(Number(val)) && val.trim() !== "");
}
