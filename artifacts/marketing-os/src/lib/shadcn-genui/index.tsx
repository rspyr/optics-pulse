import { defineComponent, createLibrary } from "@openuidev/react-lang";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts";

import type { ReactNode } from "react";

function renderBoldMarkdown(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-white">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

const CHART_COLORS = [
  "hsl(217, 91%, 60%)",
  "hsl(263, 70%, 50%)",
  "hsl(160, 60%, 45%)",
  "hsl(38, 92%, 50%)",
  "hsl(0, 84%, 60%)",
  "hsl(239, 84%, 67%)",
  "hsl(330, 81%, 60%)",
  "hsl(174, 80%, 40%)",
];

const TextBlock = defineComponent({
  name: "Text",
  props: z.object({
    content: z.string(),
    bold: z.boolean().optional(),
  }),
  description:
    "A paragraph of text. Use for conversational commentary, analysis, and insights. Use bold=true for emphasis on key metrics or numbers.",
  component: ({ props }) => (
    <p className={`text-sm leading-relaxed text-white/80 ${props.bold ? "font-semibold text-white" : ""}`}>
      {renderBoldMarkdown(props.content)}
    </p>
  ),
});

const Heading = defineComponent({
  name: "Heading",
  props: z.object({
    text: z.string(),
    level: z.number().optional(),
  }),
  description:
    "Section heading. Use for titles above visualizations or to separate distinct sections of the response.",
  component: ({ props }) => {
    const level = props.level || 3;
    if (level <= 2)
      return <h2 className="text-base font-semibold text-white tracking-tight">{props.text}</h2>;
    return <h3 className="text-sm font-semibold text-white/90 uppercase tracking-wider">{props.text}</h3>;
  },
});

const BulletItem = defineComponent({
  name: "BulletItem",
  props: z.object({
    text: z.string(),
  }),
  description: "A single bullet point item. Must be used inside a BulletList.",
  component: ({ props }) => (
    <li className="text-sm text-white/80 leading-relaxed">{renderBoldMarkdown(props.text)}</li>
  ),
});

const BulletList = defineComponent({
  name: "BulletList",
  props: z.object({
    items: z.array(BulletItem.ref),
  }),
  description:
    "An unordered bullet list. Use for listing insights, follow-up suggestions, or summarized points.",
  component: ({ props, renderNode }) => (
    <ul className="space-y-1 list-disc list-inside text-white/80">
      {renderNode(props.items)}
    </ul>
  ),
});

const MetricValue = defineComponent({
  name: "MetricValue",
  props: z.object({
    label: z.string(),
    value: z.string(),
    change: z.string().optional(),
    trend: z.enum(["up", "down", "neutral"]).optional(),
  }),
  description:
    "A single KPI metric with label and value. Use for displaying key numbers like CPL, ROAS, lead count, revenue, booking rate, etc. Optionally include change and trend direction.",
  component: ({ props }) => {
    const len = props.value.length;
    const sizeClass = len > 12 ? "text-xs" : len > 10 ? "text-sm" : len > 7 ? "text-base" : "text-2xl";
    return (
      <div className="text-center space-y-1 min-w-0 overflow-hidden">
        <div className={`${sizeClass} font-bold text-white tracking-tight whitespace-nowrap`}>{props.value}</div>
        <div className="text-[10px] uppercase tracking-widest text-white/40 whitespace-nowrap overflow-hidden text-ellipsis">{props.label}</div>
        {props.change && (
          <div
            className={`text-xs font-medium whitespace-nowrap ${
              props.trend === "up"
                ? "text-emerald-400"
                : props.trend === "down"
                  ? "text-red-400"
                  : "text-white/50"
            }`}
          >
            {props.change}
          </div>
        )}
      </div>
    );
  },
});

const MetricCard = defineComponent({
  name: "MetricCard",
  props: z.object({
    metrics: z.array(MetricValue.ref),
  }),
  description:
    "A card displaying one or more KPI metrics side by side. Use for single-number answers (CPL, ROAS) or metric summaries. Best for 1-7 metrics.",
  component: ({ props, renderNode }) => (
    <div className="rounded-xl border border-white/10 bg-gradient-to-br from-blue-500/10 to-violet-500/10 p-4 overflow-hidden">
      <div
        className={`grid gap-3 ${
          props.metrics.length === 1
            ? "grid-cols-1"
            : props.metrics.length === 2
              ? "grid-cols-2"
              : "grid-cols-2 sm:grid-cols-3"
        }`}
      >
        {renderNode(props.metrics)}
      </div>
    </div>
  ),
});

const BarChartItem = defineComponent({
  name: "BarChartItem",
  props: z.object({
    name: z.string(),
    value: z.number(),
  }),
  description: "A single bar in a bar chart. Must be used inside BarChartViz.",
  component: ({ props }) => null,
});

const BarChartViz = defineComponent({
  name: "BarChartViz",
  props: z.object({
    title: z.string().optional(),
    items: z.array(BarChartItem.ref),
    valueLabel: z.string().optional(),
  }),
  description:
    "A horizontal bar chart comparing values across categories. Use for: leads by source, spend by campaign, performance comparisons. Best for 2-12 items.",
  component: ({ props }) => {
    const data = props.items
      .filter((item) => item.type === "element")
      .map((item) => ({
        name: item.props.name,
        value: item.props.value,
      }));
    if (data.length === 0) return null;
    const barHeight = Math.max(200, data.length * 40);
    const maxLabelLen = Math.max(...data.map((d) => d.name.length));
    const yAxisWidth = Math.min(160, Math.max(80, maxLabelLen * 6));
    return (
      <div className="space-y-2">
        {props.title && (
          <div className="text-[10px] uppercase tracking-widest text-white/40">{props.title}</div>
        )}
        <div style={{ height: barHeight }} className="w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 0, right: 10, top: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
              <XAxis type="number" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 10 }} axisLine={false} tickLine={false} width={yAxisWidth} />
              <Tooltip
                contentStyle={{ background: "rgba(10,15,31,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", fontSize: "12px", color: "white" }}
                labelStyle={{ color: "rgba(255,255,255,0.7)" }}
                itemStyle={{ color: "white" }}
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
              />
              <Bar dataKey="value" fill="hsl(217, 91%, 60%)" radius={[0, 4, 4, 0]} name={props.valueLabel || "Value"} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  },
});

const TrendPoint = defineComponent({
  name: "TrendPoint",
  props: z.object({
    date: z.string(),
    value: z.number(),
  }),
  description: "A single data point in a trend line. Must be used inside TrendLineViz.",
  component: ({ props }) => null,
});

const TrendLineViz = defineComponent({
  name: "TrendLineViz",
  props: z.object({
    title: z.string().optional(),
    points: z.array(TrendPoint.ref),
    valueLabel: z.string().optional(),
  }),
  description:
    "A line/area chart showing values over time. Use for daily spend, weekly leads, monthly revenue, or any time-series data. Best for 5-60 data points with a date column.",
  component: ({ props }) => {
    const data = props.points
      .filter((p) => p.type === "element")
      .map((p) => ({
        date: p.props.date,
        value: p.props.value,
      }));
    if (data.length === 0) return null;
    return (
      <div className="space-y-2">
        {props.title && (
          <div className="text-[10px] uppercase tracking-widest text-white/40">{props.title}</div>
        )}
        <div className="h-[180px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ left: 0, right: 10, top: 5, bottom: 0 }}>
              <defs>
                <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} axisLine={false} tickLine={false} width={45} />
              <Tooltip
                contentStyle={{ background: "rgba(10,15,31,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", fontSize: "12px", color: "white" }}
                labelStyle={{ color: "rgba(255,255,255,0.7)" }}
                itemStyle={{ color: "white" }}
              />
              <Area type="monotone" dataKey="value" stroke="hsl(217, 91%, 60%)" fill="url(#trendGrad)" strokeWidth={2} name={props.valueLabel || "Value"} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  },
});

const PieSlice = defineComponent({
  name: "PieSlice",
  props: z.object({
    name: z.string(),
    value: z.number(),
  }),
  description: "A single slice in a pie chart. Must be used inside PieChartViz.",
  component: ({ props }) => null,
});

const PieChartViz = defineComponent({
  name: "PieChartViz",
  props: z.object({
    title: z.string().optional(),
    slices: z.array(PieSlice.ref),
  }),
  description:
    "A pie/donut chart showing proportional breakdown. Use for source mix, status distribution, platform split. Best for 2-8 categories.",
  component: ({ props }) => {
    const data = props.slices
      .filter((s) => s.type === "element")
      .map((s) => ({
        name: s.props.name,
        value: s.props.value,
      }));
    if (data.length === 0) return null;
    const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
    return (
      <div className="space-y-2">
        {props.title && (
          <div className="text-[10px] uppercase tracking-widest text-white/40">{props.title}</div>
        )}
        <div className="flex items-center gap-4">
          <div className="h-[140px] w-[140px] flex-shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  cx="50%"
                  cy="50%"
                  innerRadius={35}
                  outerRadius={60}
                  paddingAngle={2}
                  dataKey="value"
                  stroke="none"
                >
                  {data.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "rgba(10,15,31,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", fontSize: "12px", color: "white" }}
                  labelStyle={{ color: "rgba(255,255,255,0.7)" }}
                  itemStyle={{ color: "white" }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-col gap-1.5 flex-1 min-w-0">
            {data.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span
                  className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                  style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                />
                <span className="text-white/70 truncate flex-1">{item.name}</span>
                <span className="text-white/50">{((item.value / total) * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  },
});

const DataTableColumn = defineComponent({
  name: "DataTableColumn",
  props: z.object({
    header: z.string(),
    values: z.array(z.string()),
  }),
  description:
    "A column of data in a table. Provide the header name and an array of cell values (as strings). Must be used inside DataTable.",
  component: ({ props }) => null,
});

const DataTable = defineComponent({
  name: "DataTable",
  props: z.object({
    title: z.string().optional(),
    columns: z.array(DataTableColumn.ref),
  }),
  description:
    "A data table for detailed multi-column data. Use for campaign details, lead lists, detailed breakdowns. Best for structured data with 2-6 columns.",
  component: ({ props }) => {
    const cols = props.columns.filter((c) => c.type === "element");
    if (cols.length === 0) return null;
    const rowCount = Math.max(...cols.map((c) => c.props.values.length), 0);
    return (
      <div className="space-y-2">
        {props.title && (
          <div className="text-[10px] uppercase tracking-widest text-white/40">{props.title}</div>
        )}
        <div className="rounded-lg border border-white/10 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                {cols.map((col, i) => (
                  <TableHead key={i} className="text-white/50 text-xs font-medium h-8 px-3">
                    {col.props.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: Math.min(rowCount, 15) }).map((_, rowIdx) => (
                <TableRow key={rowIdx} className="border-white/5 hover:bg-white/[0.03]">
                  {cols.map((col, colIdx) => (
                    <TableCell key={colIdx} className="text-white/75 text-xs px-3 py-2">
                      {col.props.values[rowIdx] || "—"}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {rowCount > 15 && (
            <div className="text-[10px] text-white/30 px-3 py-1.5 border-t border-white/5">
              Showing 15 of {rowCount} rows
            </div>
          )}
        </div>
      </div>
    );
  },
});

const ListItem = defineComponent({
  name: "ListItem",
  props: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    meta: z.string().optional(),
  }),
  description:
    "A single item in a list. Includes a title, optional subtitle, and optional meta text (like a date). Must be used inside ItemList.",
  component: ({ props }) => null,
});

const ItemList = defineComponent({
  name: "ItemList",
  props: z.object({
    title: z.string().optional(),
    items: z.array(ListItem.ref),
  }),
  description:
    "A vertical list of text-heavy items. Use for changelog entries, alerts, reviews, lead names, or any list of items with title/subtitle/date.",
  component: ({ props, renderNode }) => {
    const items = props.items.filter((item) => item.type === "element");
    if (items.length === 0) return null;
    return (
      <div className="space-y-2">
        {props.title && (
          <div className="text-[10px] uppercase tracking-widest text-white/40">{props.title}</div>
        )}
        <div className="flex flex-col gap-1.5">
          {items.map((item, i) => (
            <div
              key={i}
              className="px-3 py-2 bg-white/[0.03] rounded-lg border border-white/5"
            >
              <div className="flex justify-between items-start gap-2">
                <span className="text-xs font-medium text-white/85">{item.props.title}</span>
                {item.props.meta && (
                  <span className="text-[10px] text-white/35 flex-shrink-0">{item.props.meta}</span>
                )}
              </div>
              {item.props.subtitle && (
                <div className="text-[11px] text-white/45 mt-0.5 truncate">{item.props.subtitle}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  },
});

const AlertBox = defineComponent({
  name: "AlertBox",
  props: z.object({
    message: z.string(),
    variant: z.enum(["info", "warning", "success", "error"]).optional(),
  }),
  description:
    "A callout/alert box for highlighting important insights, warnings, or positive trends. Use sparingly for key takeaways.",
  component: ({ props }) => {
    const variant = props.variant || "info";
    const styles = {
      info: "border-blue-500/30 bg-blue-500/10 text-blue-300",
      warning: "border-yellow-500/30 bg-yellow-500/10 text-yellow-300",
      success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
      error: "border-red-500/30 bg-red-500/10 text-red-300",
    };
    return (
      <div className={`rounded-lg border px-3 py-2.5 text-xs leading-relaxed ${styles[variant]}`}>
        {renderBoldMarkdown(props.message)}
      </div>
    );
  },
});

const TagBadge = defineComponent({
  name: "TagBadge",
  props: z.object({
    label: z.string(),
    variant: z.enum(["default", "secondary", "outline"]).optional(),
  }),
  description: "A small inline badge/tag. Use for status indicators, category labels, or tags within text.",
  component: ({ props }) => (
    <Badge variant={props.variant || "secondary"} className="text-[10px]">
      {props.label}
    </Badge>
  ),
});

const ProgressBar = defineComponent({
  name: "ProgressBar",
  props: z.object({
    label: z.string(),
    value: z.number(),
    max: z.number().optional(),
  }),
  description:
    "A progress bar showing completion or ratio. Value is 0-100 (percentage). Use for showing rates like booking rate, conversion rate, goal progress.",
  component: ({ props }) => (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-white/60">{props.label}</span>
        <span className="text-white/80 font-medium">{props.value}%</span>
      </div>
      <Progress value={props.value} className="h-2" />
    </div>
  ),
});

const ResponseCardChild = z.union([
  TextBlock.ref,
  Heading.ref,
  BulletList.ref,
  MetricCard.ref,
  BarChartViz.ref,
  TrendLineViz.ref,
  PieChartViz.ref,
  DataTable.ref,
  ItemList.ref,
  AlertBox.ref,
  TagBadge.ref,
  ProgressBar.ref,
]);

const ResponseCard = defineComponent({
  name: "ResponseCard",
  props: z.object({
    children: z.array(ResponseCardChild),
  }),
  description:
    "The root container for all chat response content. Children stack vertically. Always use this as the outermost wrapper. Combine Text blocks with visualizations — start with a brief text analysis, then show the data visualization, then optional follow-up insights.",
  component: ({ props, renderNode }) => (
    <div className="space-y-3">
      {renderNode(props.children)}
    </div>
  ),
});

export const shadcnChatLibrary = createLibrary({
  root: "ResponseCard",
  components: [
    ResponseCard,
    TextBlock,
    Heading,
    BulletItem,
    BulletList,
    MetricValue,
    MetricCard,
    BarChartItem,
    BarChartViz,
    TrendPoint,
    TrendLineViz,
    PieSlice,
    PieChartViz,
    DataTableColumn,
    DataTable,
    ListItem,
    ItemList,
    AlertBox,
    TagBadge,
    ProgressBar,
  ],
});
