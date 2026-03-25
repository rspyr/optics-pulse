import { ai } from "@workspace/integrations-gemini-ai";
import { SCHEMA_DESCRIPTION, executeQueryPlan, type QueryPlan } from "./data-query-executor";
import { db, leadsTable, jobsTable, campaignsTable } from "@workspace/db";
import { eq, and, gte } from "drizzle-orm";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

const QUERY_PLAN_SYSTEM_PROMPT = `You are an expert marketing data analyst. Given a user's natural language question about their marketing performance data, generate a structured JSON query plan to retrieve the relevant data.

${SCHEMA_DESCRIPTION}

You MUST respond with ONLY valid JSON (no markdown fences, no extra text). The JSON schema:
{
  "tables": ["string array of table names to query"],
  "filters": { "optional key-value filter pairs like source, status, platform, etc." },
  "aggregations": ["optional - e.g. 'sum', 'count', 'avg'"],
  "groupBy": ["optional - e.g. 'date', 'campaignId', 'source'"],
  "orderBy": [{"column": "string", "direction": "asc|desc"}],
  "limit": 50,
  "dateRange": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "computedMetrics": ["optional - e.g. 'cpl', 'roas', 'booking_rate', 'close_rate', 'cpc', 'ctr', 'total_spend', 'total_revenue', 'avg_job_value', 'lead_count'"]
}

Rules:
- Today's date is ${new Date().toISOString().split("T")[0]}
- Default date range: last 30 days unless the user specifies otherwise
- "last week" = last 7 days, "this month" = from 1st of current month to today, "last quarter" = last 90 days
- For questions about KPIs (CPL, ROAS, booking rate, etc.), use computedMetrics instead of raw table queries
- For "overview"/"summary"/"how am I doing" questions, include computedMetrics: ["cpl","roas","booking_rate","close_rate","lead_count","total_spend","total_revenue"]
- For campaign performance, query both "campaigns" and "campaign_daily_stats"
- For lead breakdowns by source, query "leads"
- For coordinator/rep performance, query "coordinator_daily_stats"
- For "funnel type" questions: query "leads" with groupBy: ["leadType"] — leadType stores the funnel type name (e.g. "Fit Funnel", "Emergency Repair"). Also query "campaigns" to get total spend data to correlate.
- For "which funnels does this client have", query "tenant_funnel_types" (joined with funnel_types automatically)
- Keep limit reasonable (50 max) unless user asks for "all"
- Never include tenantId in filters - it's always applied automatically
- For "why" questions about metric changes, include data from both the current and previous period`;

const OPENUI_LANG_SYSTEM_PROMPT = `You are a friendly marketing data analyst that responds using openui-lang, a declarative UI language. Your ENTIRE response must be valid openui-lang code — no markdown, no explanations, just openui-lang.

## Syntax Rules

1. Each statement is on its own line: \`identifier = Expression\`
2. \`root\` is the entry point — every program must define \`root = ResponseCard(...)\`
3. Expressions are: strings ("..."), numbers, booleans (true/false), arrays ([...]), objects ({...}), or component calls TypeName(arg1, arg2, ...)
4. Use references for readability: define \`name = ...\` on one line, then use \`name\` later
5. EVERY variable (except root) MUST be referenced by at least one other variable. Unreferenced variables are silently dropped and will NOT render. Always include defined variables in their parent's children/items array.
6. Arguments are POSITIONAL (order matters, not names)
7. Optional arguments can be omitted from the end
8. No operators, no logic, no variables — only declarations
9. Strings use double quotes with backslash escaping

## Hoisting & Streaming (CRITICAL)

openui-lang supports hoisting: a reference can be used BEFORE it is defined. The parser resolves all references after the full input is parsed.

During streaming, the output is re-parsed on every chunk. Undefined references are temporarily unresolved and appear once their definitions stream in. This creates a progressive top-down reveal — structure first, then data fills in.

**Recommended statement order for optimal streaming:**
1. \`root = ResponseCard(...)\` — UI shell appears immediately
2. Component definitions — fill in as they stream
3. Data values — leaf content last

Always write the root = ResponseCard(...) statement first so the UI shell appears immediately, even before child data has streamed in.

## Available Components

### ResponseCard(children)
The root container for all chat response content. Children stack vertically. Always use this as the outermost wrapper. Combine Text blocks with visualizations — start with a brief text analysis, then show the data visualization, then optional follow-up insights.
- children: array of child components (required)

### Text(content, bold)
A paragraph of text. Use for conversational commentary, analysis, and insights. Use bold=true for emphasis on key metrics or numbers.
- content: string (required)
- bold: boolean (optional)

### Heading(text, level)
Section heading. Use for titles above visualizations or to separate distinct sections of the response.
- text: string (required)
- level: number (optional, default 3)

### BulletItem(text)
A single bullet point item. Must be used inside a BulletList.
- text: string (required)

### BulletList(items)
An unordered bullet list. Use for listing insights, follow-up suggestions, or summarized points.
- items: array of BulletItem (required)

### MetricValue(label, value, change, trend)
A single KPI metric with label and value. Use for displaying key numbers like CPL, ROAS, lead count, revenue, booking rate, etc.
- label: string (required)
- value: string (required) — formatted value like "$45.20", "3.2x", "127"
- change: string (optional) — e.g. "+12.5% vs last month"
- trend: "up" | "down" | "neutral" (optional)

### MetricCard(metrics)
A card displaying one or more KPI metrics side by side. Use for single-number answers (CPL, ROAS) or metric summaries. Best for 1-7 metrics.
- metrics: array of MetricValue (required)

### BarChartItem(name, value)
A single bar in a bar chart. Must be used inside BarChartViz.
- name: string (required)
- value: number (required) — must be a raw number, NOT a formatted string

### BarChartViz(title, items, valueLabel)
A horizontal bar chart comparing values across categories. Use for: leads by source, spend by campaign, performance comparisons. Best for 2-12 items.
- title: string (optional)
- items: array of BarChartItem (required)
- valueLabel: string (optional)

### TrendPoint(date, value)
A single data point in a trend line. Must be used inside TrendLineViz.
- date: string (required) — formatted date like "Jan 15", "2024-03-01"
- value: number (required) — must be a raw number

### TrendLineViz(title, points, valueLabel)
A line/area chart showing values over time. Use for daily spend, weekly leads, monthly revenue, or any time-series data. Best for 5-60 data points.
- title: string (optional)
- points: array of TrendPoint (required)
- valueLabel: string (optional)

### PieSlice(name, value)
A single slice in a pie chart. Must be used inside PieChartViz.
- name: string (required)
- value: number (required) — must be a raw number

### PieChartViz(title, slices)
A pie/donut chart showing proportional breakdown. Use for source mix, status distribution, platform split. Best for 2-8 categories.
- title: string (optional)
- slices: array of PieSlice (required)

### DataTableColumn(header, values)
A column of data in a table. Provide the header name and an array of cell values (as strings). Must be used inside DataTable.
- header: string (required)
- values: array of strings (required)

### DataTable(title, columns)
A data table for detailed multi-column data. Use for campaign details, lead lists, detailed breakdowns. Best for structured data with 2-6 columns.
- title: string (optional)
- columns: array of DataTableColumn (required)

### ListItem(title, subtitle, meta)
A single item in a list. Must be used inside ItemList.
- title: string (required)
- subtitle: string (optional)
- meta: string (optional) — e.g. a date or status

### ItemList(title, items)
A vertical list of text-heavy items. Use for changelog entries, alerts, reviews, lead names.
- title: string (optional)
- items: array of ListItem (required)

### AlertBox(message, variant)
A callout/alert box for highlighting important insights, warnings, or positive trends. Use sparingly for key takeaways.
- message: string (required)
- variant: "info" | "warning" | "success" | "error" (optional, default "info")

### TagBadge(label, variant)
A small inline badge/tag. Use for status indicators, category labels.
- label: string (required)
- variant: "default" | "secondary" | "outline" (optional)

### ProgressBar(label, value, max)
A progress bar showing completion or ratio. Value is 0-100 (percentage).
- label: string (required)
- value: number (required)
- max: number (optional)

## Important Rules
- ALWAYS start with root = ResponseCard(...)
- Write statements in TOP-DOWN order: root → components → data (leverages hoisting for progressive streaming)
- Each statement on its own line
- No trailing text or explanations — output ONLY openui-lang code
- Format currency values as $X,XXX.XX in text and metric values
- Format percentages as X.X% in text and metric values
- Use MetricCard for single KPI answers (CPL, ROAS, lead count, etc.)
- Use BarChartViz for comparing values across categories (leads by source, spend by campaign)
- Use TrendLineViz for data over time (daily leads, weekly spend, monthly revenue)
- Use PieChartViz for proportional breakdowns (source mix, status distribution) with 2-8 categories
- Use DataTable for detailed multi-column data (campaign details, lead lists)
- Use ItemList for text-heavy items (changelog entries, alerts, reviews)
- Use AlertBox sparingly for critical insights or warnings
- Use BulletList for follow-up question suggestions
- Combine multiple visualization types when appropriate (e.g. MetricCard + BarChartViz)
- All numeric data values in charts must be actual numbers, not formatted strings
- Keep Text blocks concise — 1-3 sentences each
- Use bold=true on Text for key metric callouts
- NEVER define a variable without referencing it from the tree. Every variable must be reachable from root, otherwise it will not render.

## Example Response

For a question like "What's my cost per lead?":

root = ResponseCard([insight, metrics, suggestion])
insight = Text("Here's your cost per lead breakdown for the last 30 days.")
metrics = MetricCard([m1, m2, m3])
m1 = MetricValue("Cost Per Lead", "$42.50", "-8.2% vs last month", "down")
m2 = MetricValue("Total Spend", "$8,500.00")
m3 = MetricValue("Total Leads", "200", "+15 vs last month", "up")
suggestion = BulletList([s1, s2])
s1 = BulletItem("Try asking: Which source has the lowest CPL?")
s2 = BulletItem("Try asking: Show me CPL trend over the last 3 months")

For a question like "Show me leads by source":

root = ResponseCard([insight, chart, detail])
insight = Text("Here's your lead distribution across sources for the last 30 days.")
chart = BarChartViz("Leads by Source", [b1, b2, b3, b4], "Leads")
b1 = BarChartItem("Google Ads", 85)
b2 = BarChartItem("Facebook", 52)
b3 = BarChartItem("Direct", 38)
b4 = BarChartItem("Referral", 25)
detail = Text("Google Ads is your top source with 85 leads (42.5% of total). Consider increasing budget there.", true)`;

const VALID_TABLES = [
  "leads", "campaigns", "campaign_daily_stats", "jobs",
  "attribution_events", "reviews", "review_daily_stats",
  "coordinator_daily_stats", "automation_rules", "automation_alerts",
  "change_logs", "call_attempts", "scheduled_followups",
  "integration_sync_logs", "users", "funnel_types", "tenant_funnel_types",
] as const;

function parseAndValidateQueryPlan(text: string): QueryPlan | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(extractJson(text));
  } catch {
    console.error("[Chat AI] Failed to parse query plan:", text.substring(0, 200));
    return null;
  }

  const tables = Array.isArray(raw.tables)
    ? (raw.tables as string[]).filter((t) => (VALID_TABLES as readonly string[]).includes(t))
    : [];

  return {
    tables,
    filters: raw.filters && typeof raw.filters === "object" ? raw.filters as Record<string, unknown> : undefined,
    aggregations: Array.isArray(raw.aggregations) ? raw.aggregations as string[] : undefined,
    groupBy: Array.isArray(raw.groupBy) ? raw.groupBy as string[] : undefined,
    orderBy: Array.isArray(raw.orderBy)
      ? (raw.orderBy as Array<Record<string, string>>).filter(
          (o) => typeof o.column === "string" && (o.direction === "asc" || o.direction === "desc")
        ).map((o) => ({ column: o.column, direction: o.direction as "asc" | "desc" }))
      : undefined,
    limit: typeof raw.limit === "number" ? Math.min(Math.max(raw.limit, 1), 100) : undefined,
    dateRange: raw.dateRange && typeof raw.dateRange === "object"
      ? raw.dateRange as { start: string; end: string }
      : undefined,
    computedMetrics: Array.isArray(raw.computedMetrics) ? raw.computedMetrics as string[] : undefined,
  };
}

function extractTextFromOpenUILang(content: string): string {
  const textMatches = content.match(/Text\("([^"]+)"/g);
  if (textMatches && textMatches.length > 0) {
    return textMatches
      .map(m => {
        const match = m.match(/Text\("([^"]+)"/);
        return match ? match[1] : "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return content.slice(0, 300);
}

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) return arrayMatch[0];
  }
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];
  return text;
}

export async function processQuestionStream(
  question: string,
  tenantId: number,
  conversationHistory: ConversationTurn[] = [],
  onChunk: (chunk: { type: string; content?: string; done?: boolean }) => void
): Promise<void> {
  try {
    onChunk({ type: "status", content: "Understanding your question..." });

    const historyForContext = conversationHistory
      .slice(-6)
      .map((t) => ({
        role: t.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{
          text: t.role === "assistant"
            ? extractTextFromOpenUILang(t.content)
            : t.content.slice(0, 500),
        }],
      }));

    const queryPlanResponse = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: [
        ...historyForContext,
        { role: "user", parts: [{ text: question }] },
      ],
      config: {
        systemInstruction: QUERY_PLAN_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        maxOutputTokens: 2048,
      },
    });

    const queryPlan = parseAndValidateQueryPlan(queryPlanResponse.text?.trim() || "{}");
    if (!queryPlan) {
      onChunk({ type: "text", content: 'root = ResponseCard([msg])\nmsg = Text("I had trouble understanding that question. Could you try rephrasing it?")' });
      onChunk({ type: "done", done: true });
      return;
    }

    onChunk({ type: "status", content: "Querying your data..." });

    const queryResult = await executeQueryPlan(tenantId, queryPlan);

    onChunk({ type: "status", content: "Building your insights..." });

    const streamResponse = await ai.models.generateContentStream({
      model: "gemini-3-pro-preview",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `User question: "${question}"

Query results (${queryResult.data.length} rows):
${JSON.stringify(queryResult.data.slice(0, 30), null, 2)}

${queryResult.summary}

Generate a rich openui-lang response with appropriate visualizations and conversational insights based on this data.`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: OPENUI_LANG_SYSTEM_PROMPT,
        maxOutputTokens: 8192,
      },
    });

    for await (const chunk of streamResponse) {
      const text = chunk.text;
      if (text) {
        onChunk({ type: "text", content: text });
      }
    }

    onChunk({ type: "done", done: true });
  } catch (err) {
    console.error("[Chat AI Stream] Error:", err);
    onChunk({ type: "text", content: 'root = ResponseCard([msg])\nmsg = Text("I encountered an error analyzing your data. Please try again.")' });
    onChunk({ type: "done", done: true });
  }
}

export async function generateSuggestions(tenantId: number): Promise<string[]> {
  const fallbackSuggestions = [
    "How am I performing this month?",
    "What's my cost per lead?",
    "Show me leads broken down by source",
    "Which campaigns are performing best?",
    "What's my ROAS?",
  ];

  try {
    const now = new Date();
    const start30 = new Date(now.getTime() - 30 * 86400000);

    const [leadRows, jobRows, campaignRows] = await Promise.all([
      db
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.tenantId, tenantId),
            gte(leadsTable.createdAt, start30)
          )
        ),
      db
        .select()
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.tenantId, tenantId),
            gte(jobsTable.createdAt, start30)
          )
        ),
      db
        .select()
        .from(campaignsTable)
        .where(eq(campaignsTable.tenantId, tenantId)),
    ]);

    const leadCount = leadRows.length;
    const bookedCount = leadRows.filter(l => l.status === "booked" || l.status === "sold").length;
    const sources = [...new Set(leadRows.map(l => l.source).filter(Boolean))];
    const completedJobs = jobRows.filter(j => j.status === "completed");
    const totalRevenue = completedJobs.reduce((s, j) => s + (j.revenue || 0), 0);
    const activeCampaigns = campaignRows.filter(c => c.status === "active" || c.status === "ENABLED");
    const platforms = [...new Set(campaignRows.map(c => c.platform).filter(Boolean))];

    const summaryContext = `Tenant data summary (last 30 days):
- ${leadCount} leads from sources: ${sources.slice(0, 5).join(", ") || "unknown"}
- ${bookedCount} booked/sold leads (booking rate: ${leadCount > 0 ? ((bookedCount / leadCount) * 100).toFixed(1) : 0}%)
- ${completedJobs.length} completed jobs, $${totalRevenue.toFixed(0)} total revenue
- ${activeCampaigns.length} active campaigns across platforms: ${platforms.join(", ") || "none"}
- Today's date: ${now.toISOString().split("T")[0]}`;

    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: [
        {
          role: "user",
          parts: [{ text: summaryContext }],
        },
      ],
      config: {
        systemInstruction: `You are a marketing analytics assistant. Based on the tenant's data summary, generate exactly 5 contextual, actionable questions a business owner would want to ask about their marketing data right now.

Rules:
- Questions should be specific to what the data shows (reference actual sources, platforms, metrics)
- Mix strategic questions ("Why is X happening?") with tactical ("Show me Y breakdown")
- If booking rate is low, suggest a question about it
- If revenue is significant, suggest revenue/ROAS questions
- If multiple ad platforms, suggest platform comparison
- Keep questions concise and natural-sounding

Respond with ONLY a JSON array of 5 strings. Example:
["Question 1?", "Question 2?", "Question 3?", "Question 4?", "Question 5?"]`,
        responseMimeType: "application/json",
        maxOutputTokens: 512,
      },
    });

    const parsed = JSON.parse(extractJson(response.text?.trim() || "[]"));
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((s: unknown) => typeof s === "string")) {
      return parsed.slice(0, 5);
    }

    return fallbackSuggestions;
  } catch (err) {
    console.error("[Chat AI] Error generating suggestions:", err);
    return fallbackSuggestions;
  }
}
