import { ai } from "@workspace/integrations-gemini-ai";
import { OPENUI_SYSTEM_PROMPT } from "@workspace/chat-genui";
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
        systemInstruction: OPENUI_SYSTEM_PROMPT,
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
