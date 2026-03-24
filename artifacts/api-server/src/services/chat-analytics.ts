import { ai } from "@workspace/integrations-gemini-ai";
import { SCHEMA_DESCRIPTION, executeQueryPlan, type QueryPlan } from "./data-query-executor";
import { db, leadsTable, jobsTable, campaignsTable } from "@workspace/db";
import { eq, and, gte } from "drizzle-orm";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

interface QueryResult {
  answer: string;
  data?: Record<string, unknown>[];
  chartType?: string;
  chartLabel?: string;
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

const ANSWER_SYSTEM_PROMPT = `You are a friendly marketing data analyst helping a business owner understand their marketing performance. Given query results from their data, provide a clear, conversational answer.

Rules:
- Use **bold** for key numbers and metrics
- Use bullet points (•) for lists
- Be concise but insightful — highlight what matters
- If data shows concerning trends, note them tactfully
- Suggest follow-up questions when appropriate
- Format currency as $X,XXX.XX
- Format percentages as X.X%
- Include a chartType recommendation in your response

You MUST respond with ONLY valid JSON:
{
  "answer": "Your natural language response with **bold** formatting",
  "chartType": "one of: bar, horizontal-bar, table, number, trend-line, pie, list",
  "chartLabel": "A short label for the visualization"
}

Chart type guidelines:
- "number" — single KPI metric (CPL, ROAS, etc.)
- "bar" — comparing values across categories (leads by source, spend by campaign)
- "horizontal-bar" — same as bar but for many categories or long labels
- "table" — detailed multi-column data (campaign details, lead lists)
- "trend-line" — data over time (daily spend, weekly leads)
- "pie" — proportional breakdown (source mix, status distribution)
- "list" — text-heavy items (changelog entries, alerts)`;

const VALID_TABLES = [
  "leads", "campaigns", "campaign_daily_stats", "jobs",
  "attribution_events", "reviews", "review_daily_stats",
  "coordinator_daily_stats", "automation_rules", "automation_alerts",
  "change_logs", "call_attempts", "scheduled_followups",
  "integration_sync_logs", "users", "funnel_types", "tenant_funnel_types",
] as const;

const VALID_CHART_TYPES = ["bar", "horizontal-bar", "table", "number", "trend-line", "pie", "donut", "list"] as const;

function normalizeChartType(type: string): string {
  return type === "donut" ? "pie" : type;
}

interface AnswerResponse {
  answer: string;
  chartType?: string;
  chartLabel?: string;
}

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

function parseAnswerResponse(text: string): AnswerResponse {
  try {
    const raw = JSON.parse(extractJson(text));
    const rawType = typeof raw.chartType === "string" && (VALID_CHART_TYPES as readonly string[]).includes(raw.chartType)
      ? raw.chartType
      : undefined;
    return {
      answer: typeof raw.answer === "string" ? raw.answer : "",
      chartType: rawType ? normalizeChartType(rawType) : undefined,
      chartLabel: typeof raw.chartLabel === "string" ? raw.chartLabel : undefined,
    };
  } catch {
    console.error("[Chat AI] Failed to parse answer:", text.substring(0, 200));
    return { answer: text || "I processed your data but had trouble formatting the response." };
  }
}

function parseVizResponse(text: string): { chartType: string; chartLabel: string } {
  try {
    const raw = JSON.parse(extractJson(text));
    const rawType = typeof raw.chartType === "string" && (VALID_CHART_TYPES as readonly string[]).includes(raw.chartType)
      ? raw.chartType
      : "table";
    return {
      chartType: normalizeChartType(rawType),
      chartLabel: typeof raw.chartLabel === "string" ? raw.chartLabel : "Results",
    };
  } catch {
    console.error("[Chat AI] Failed to parse viz response, using fallback:", text.substring(0, 200));
    return { chartType: "table", chartLabel: "Results" };
  }
}

export async function processQuestion(
  question: string,
  tenantId: number,
  conversationHistory: ConversationTurn[] = []
): Promise<QueryResult> {
  try {
    const historyForContext = conversationHistory
      .slice(-6)
      .map((t) => ({
        role: t.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: t.content.slice(0, 500) }],
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
      return {
        answer: "I had trouble understanding that question. Could you try rephrasing it?",
        chartType: "number",
      };
    }

    const queryResult = await executeQueryPlan(tenantId, queryPlan);

    const answerResponse = await ai.models.generateContent({
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

Generate a helpful answer with the appropriate chart type.`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: ANSWER_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        maxOutputTokens: 4096,
      },
    });

    const answerParsed = parseAnswerResponse(answerResponse.text?.trim() || "{}");

    return {
      answer: answerParsed.answer || "Here are your results.",
      data: queryResult.data,
      chartType: answerParsed.chartType || "table",
      chartLabel: answerParsed.chartLabel,
    };
  } catch (err) {
    console.error("[Chat AI] Error processing question:", err);
    return {
      answer: "I encountered an error analyzing your data. Please try again or rephrase your question.",
      chartType: "number",
    };
  }
}

export async function processQuestionStream(
  question: string,
  tenantId: number,
  conversationHistory: ConversationTurn[] = [],
  onChunk: (chunk: { type: string; content?: string; data?: Record<string, unknown>[]; chartType?: string; chartLabel?: string; done?: boolean }) => void
): Promise<void> {
  try {
    onChunk({ type: "status", content: "Understanding your question..." });

    const historyForContext = conversationHistory
      .slice(-6)
      .map((t) => ({
        role: t.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: t.content.slice(0, 500) }],
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
      onChunk({ type: "text", content: "I had trouble understanding that question. Could you try rephrasing it?" });
      onChunk({ type: "done", done: true });
      return;
    }

    onChunk({ type: "status", content: "Querying your data..." });

    const queryResult = await executeQueryPlan(tenantId, queryPlan);

    onChunk({ type: "status", content: "Analyzing results..." });

    const [vizResponse, streamResponse] = await Promise.all([
      ai.models.generateContent({
        model: "gemini-3-pro-preview",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `User question: "${question}"

Data shape: ${queryResult.data.length} rows, columns: ${Object.keys(queryResult.data[0] || {}).join(", ")}
Sample: ${JSON.stringify(queryResult.data.slice(0, 3))}

Pick the best visualization. Respond with ONLY valid JSON:
{"chartType": "one of: bar, horizontal-bar, table, number, trend-line, pie, list", "chartLabel": "short label"}`,
              },
            ],
          },
        ],
        config: {
          systemInstruction: `You are a data visualization expert. Choose the best chart type for the given data and question.
- "number" — single KPI or 1 row with few columns
- "bar" — comparing values across categories (≤12 items)
- "horizontal-bar" — many categories or long labels
- "trend-line" — data over time with a date column
- "pie" — proportional breakdown (≤8 items)
- "list" — text-heavy items (logs, alerts, reviews)
- "table" — detailed multi-column data`,
          responseMimeType: "application/json",
          maxOutputTokens: 256,
        },
      }),
      ai.models.generateContentStream({
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

Provide a helpful, conversational answer. Use **bold** for key numbers. Use bullet points (•) for lists. Be concise but insightful. Format currency as $X,XXX.XX and percentages as X.X%.`,
              },
            ],
          },
        ],
        config: {
          systemInstruction: "You are a friendly marketing data analyst helping a business owner understand their marketing performance. Respond in plain text with **bold** for emphasis. Be concise, highlight what matters, and suggest follow-up questions.",
          maxOutputTokens: 4096,
        },
      }),
    ]);

    const { chartType, chartLabel } = parseVizResponse(vizResponse.text?.trim() || "{}");

    for await (const chunk of streamResponse) {
      const text = chunk.text;
      if (text) {
        onChunk({ type: "text", content: text });
      }
    }

    onChunk({
      type: "data",
      data: queryResult.data,
      chartType,
      chartLabel,
    });

    onChunk({ type: "done", done: true });
  } catch (err) {
    console.error("[Chat AI Stream] Error:", err);
    onChunk({ type: "text", content: "I encountered an error analyzing your data. Please try again." });
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
