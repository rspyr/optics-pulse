import { defineComponent, createLibrary, type Library, type DefinedComponent } from "@openuidev/react-lang";
import { z } from "zod";

export const TextBlock = defineComponent({
  name: "Text",
  props: z.object({
    content: z.string(),
    bold: z.boolean().optional(),
  }),
  description:
    "A paragraph of text. Use for conversational commentary, analysis, and insights. Use bold=true for emphasis on key metrics or numbers.",
  component: () => null,
});

export const Heading = defineComponent({
  name: "Heading",
  props: z.object({
    text: z.string(),
    level: z.number().optional(),
  }),
  description:
    "Section heading. Use for titles above visualizations or to separate distinct sections of the response.",
  component: () => null,
});

export const BulletItem = defineComponent({
  name: "BulletItem",
  props: z.object({
    text: z.string(),
  }),
  description: "A single bullet point item. Must be used inside a BulletList.",
  component: () => null,
});

export const BulletList = defineComponent({
  name: "BulletList",
  props: z.object({
    items: z.array(BulletItem.ref),
  }),
  description:
    "An unordered bullet list. Use for listing insights, follow-up suggestions, or summarized points.",
  component: () => null,
});

export const MetricValue = defineComponent({
  name: "MetricValue",
  props: z.object({
    label: z.string(),
    value: z.string(),
    change: z.string().optional(),
    trend: z.enum(["up", "down", "neutral"]).optional(),
  }),
  description:
    "A single KPI metric with label and value. Use for displaying key numbers like CPL, ROAS, lead count, revenue, booking rate, etc. Optionally include change and trend direction.",
  component: () => null,
});

export const MetricCard = defineComponent({
  name: "MetricCard",
  props: z.object({
    metrics: z.array(MetricValue.ref),
  }),
  description:
    "A card displaying one or more KPI metrics side by side. Use for single-number answers (CPL, ROAS) or metric summaries. Best for 1-7 metrics.",
  component: () => null,
});

export const BarChartItem = defineComponent({
  name: "BarChartItem",
  props: z.object({
    name: z.string(),
    value: z.number(),
  }),
  description: "A single bar in a bar chart. Must be used inside BarChartViz.",
  component: () => null,
});

export const BarChartViz = defineComponent({
  name: "BarChartViz",
  props: z.object({
    title: z.string().optional(),
    items: z.array(BarChartItem.ref),
    valueLabel: z.string().optional(),
  }),
  description:
    "A horizontal bar chart comparing values across categories. Use for: leads by source, spend by campaign, performance comparisons. Best for 2-12 items.",
  component: () => null,
});

export const TrendPoint = defineComponent({
  name: "TrendPoint",
  props: z.object({
    date: z.string(),
    value: z.number(),
  }),
  description: "A single data point in a trend line. Must be used inside TrendLineViz.",
  component: () => null,
});

export const TrendLineViz = defineComponent({
  name: "TrendLineViz",
  props: z.object({
    title: z.string().optional(),
    points: z.array(TrendPoint.ref),
    valueLabel: z.string().optional(),
  }),
  description:
    "A line/area chart showing values over time. Use for daily spend, weekly leads, monthly revenue, or any time-series data. Best for 5-60 data points with a date column.",
  component: () => null,
});

export const PieSlice = defineComponent({
  name: "PieSlice",
  props: z.object({
    name: z.string(),
    value: z.number(),
  }),
  description: "A single slice in a pie chart. Must be used inside PieChartViz.",
  component: () => null,
});

export const PieChartViz = defineComponent({
  name: "PieChartViz",
  props: z.object({
    title: z.string().optional(),
    slices: z.array(PieSlice.ref),
  }),
  description:
    "A pie/donut chart showing proportional breakdown. Use for source mix, status distribution, platform split. Best for 2-8 categories.",
  component: () => null,
});

export const DataTableColumn = defineComponent({
  name: "DataTableColumn",
  props: z.object({
    header: z.string(),
    values: z.array(z.string()),
  }),
  description:
    "A column of data in a table. Provide the header name and an array of cell values (as strings). Must be used inside DataTable.",
  component: () => null,
});

export const DataTable = defineComponent({
  name: "DataTable",
  props: z.object({
    title: z.string().optional(),
    columns: z.array(DataTableColumn.ref),
  }),
  description:
    "A data table for detailed multi-column data. Use for campaign details, lead lists, detailed breakdowns. Best for structured data with 2-6 columns.",
  component: () => null,
});

export const ListItem = defineComponent({
  name: "ListItem",
  props: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    meta: z.string().optional(),
  }),
  description:
    "A single item in a list. Includes a title, optional subtitle, and optional meta text (like a date). Must be used inside ItemList.",
  component: () => null,
});

export const ItemList = defineComponent({
  name: "ItemList",
  props: z.object({
    title: z.string().optional(),
    items: z.array(ListItem.ref),
  }),
  description:
    "A vertical list of text-heavy items. Use for changelog entries, alerts, reviews, lead names, or any list of items with title/subtitle/date.",
  component: () => null,
});

export const AlertBox = defineComponent({
  name: "AlertBox",
  props: z.object({
    message: z.string(),
    variant: z.enum(["info", "warning", "success", "error"]).optional(),
  }),
  description:
    "A callout/alert box for highlighting important insights, warnings, or positive trends. Use sparingly for key takeaways.",
  component: () => null,
});

export const TagBadge = defineComponent({
  name: "TagBadge",
  props: z.object({
    label: z.string(),
    variant: z.enum(["default", "secondary", "outline"]).optional(),
  }),
  description: "A small inline badge/tag. Use for status indicators, category labels, or tags within text.",
  component: () => null,
});

export const ProgressBar = defineComponent({
  name: "ProgressBar",
  props: z.object({
    label: z.string(),
    value: z.number(),
    max: z.number().optional(),
  }),
  description:
    "A progress bar showing completion or ratio. Value is 0-100 (percentage). Use for showing rates like booking rate, conversion rate, goal progress.",
  component: () => null,
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

export const ResponseCard = defineComponent({
  name: "ResponseCard",
  props: z.object({
    children: z.array(ResponseCardChild),
  }),
  description:
    "The root container for all chat response content. Children stack vertically. Always use this as the outermost wrapper. Combine Text blocks with visualizations — start with a brief text analysis, then show the data visualization, then optional follow-up insights.",
  component: () => null,
});

export const ALL_COMPONENTS: DefinedComponent[] = [
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
];

export const PROMPT_OPTIONS = {
  preamble:
    "You are a friendly marketing data analyst. Given query results from a business owner's marketing data, generate a rich UI response using openui-lang that includes both conversational analysis and appropriate data visualizations. Always start with a brief Text insight, then show the most appropriate visualization, then optionally add follow-up insights or suggestions.",
  additionalRules: [
    "Format currency values as $X,XXX.XX in text and metric values",
    "Format percentages as X.X% in text and metric values",
    "Use MetricCard for single KPI answers (CPL, ROAS, lead count, etc.)",
    "Use BarChartViz for comparing values across categories (leads by source, spend by campaign)",
    "Use TrendLineViz for data over time (daily leads, weekly spend, monthly revenue)",
    "Use PieChartViz for proportional breakdowns (source mix, status distribution) with 2-8 categories",
    "Use DataTable for detailed multi-column data (campaign details, lead lists)",
    "Use ItemList for text-heavy items (changelog entries, alerts, reviews)",
    "Use AlertBox sparingly for critical insights or warnings",
    "Use BulletList for follow-up question suggestions",
    "Combine multiple visualization types when appropriate (e.g. MetricCard + BarChartViz)",
    "All numeric data values in charts must be actual numbers, not formatted strings",
    "Keep Text blocks concise — 1-3 sentences each",
    "Use bold=true on Text for key metric callouts",
  ],
};
