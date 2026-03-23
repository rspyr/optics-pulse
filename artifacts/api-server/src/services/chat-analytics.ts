import { ai } from "@workspace/integrations-gemini-ai";
import { SCHEMA_DESCRIPTION, executeQueryPlan } from "./data-query-executor";
import { db, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable } from "@workspace/db";
import { eq, and, gte, lte, inArray, SQL, desc } from "drizzle-orm";

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

    const planText = queryPlanResponse.text?.trim() || "{}";
    let queryPlan: any;
    try {
      queryPlan = JSON.parse(planText);
    } catch {
      console.error("[Chat AI] Failed to parse query plan:", planText);
      return {
        answer: "I had trouble understanding that question. Could you try rephrasing it?",
        chartType: "number",
      };
    }

    if (!queryPlan.tables || !Array.isArray(queryPlan.tables)) {
      queryPlan.tables = [];
    }

    const validTables = [
      "leads", "campaigns", "campaign_daily_stats", "jobs",
      "attribution_events", "reviews", "review_daily_stats",
      "coordinator_daily_stats", "automation_rules", "automation_alerts",
      "change_logs", "call_attempts", "scheduled_followups",
      "integration_sync_logs", "users",
    ];
    queryPlan.tables = queryPlan.tables.filter((t: string) =>
      validTables.includes(t)
    );

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

    const answerText = answerResponse.text?.trim() || "{}";
    let answerParsed: any;
    try {
      answerParsed = JSON.parse(answerText);
    } catch {
      console.error("[Chat AI] Failed to parse answer:", answerText);
      return {
        answer: answerText || "I processed your data but had trouble formatting the response.",
        data: queryResult.data,
        chartType: "table",
      };
    }

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

    const planText = queryPlanResponse.text?.trim() || "{}";
    let queryPlan: any;
    try {
      queryPlan = JSON.parse(planText);
    } catch {
      onChunk({ type: "text", content: "I had trouble understanding that question. Could you try rephrasing it?" });
      onChunk({ type: "done", done: true });
      return;
    }

    if (!queryPlan.tables || !Array.isArray(queryPlan.tables)) {
      queryPlan.tables = [];
    }

    const validTables = [
      "leads", "campaigns", "campaign_daily_stats", "jobs",
      "attribution_events", "reviews", "review_daily_stats",
      "coordinator_daily_stats", "automation_rules", "automation_alerts",
      "change_logs", "call_attempts", "scheduled_followups",
      "integration_sync_logs", "users",
    ];
    queryPlan.tables = queryPlan.tables.filter((t: string) =>
      validTables.includes(t)
    );

    onChunk({ type: "status", content: "Querying your data..." });

    const queryResult = await executeQueryPlan(tenantId, queryPlan);

    onChunk({ type: "status", content: "Analyzing results..." });

    const stream = await ai.models.generateContentStream({
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
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        onChunk({ type: "text", content: text });
      }
    }

    let chartType = "table";
    let chartLabel = "Results";
    if (queryResult.data.length === 1 && Object.keys(queryResult.data[0]).length <= 5) {
      chartType = "number";
      chartLabel = "Key Metric";
    } else if (queryResult.data.length > 1) {
      const keys = Object.keys(queryResult.data[0] || {});
      const hasDateKey = keys.some(k => k.toLowerCase().includes("date"));
      const numericKeys = keys.filter(k => typeof queryResult.data[0][k] === "number");

      if (hasDateKey && numericKeys.length > 0) {
        chartType = "trend-line";
        chartLabel = "Trend";
      } else if (numericKeys.length > 0 && queryResult.data.length <= 10) {
        chartType = "bar";
        chartLabel = "Comparison";
      } else {
        chartType = "table";
        chartLabel = "Data";
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
  try {
    const now = new Date();
    const start30 = new Date(now.getTime() - 30 * 86400000);
    const startStr = start30.toISOString().split("T")[0];
    const endStr = now.toISOString().split("T")[0];

    const [leadCount, jobRevenue] = await Promise.all([
      db
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.tenantId, tenantId),
            gte(leadsTable.createdAt, start30)
          )
        )
        .then((r) => r.length),
      db
        .select()
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.tenantId, tenantId),
            eq(jobsTable.status, "completed"),
            gte(jobsTable.completedAt, start30)
          )
        )
        .then((r) => r.reduce((s, j) => s + (j.revenue || 0), 0)),
    ]);

    const suggestions: string[] = [
      "How am I performing this month?",
      "What's my cost per lead?",
      "Show me leads broken down by source",
      "Which campaigns are performing best?",
      "What's my ROAS?",
    ];

    if (leadCount > 0) {
      suggestions.unshift("What's my booking rate and how can I improve it?");
    }
    if (jobRevenue > 0) {
      suggestions.unshift("Show me my revenue trend for the last 30 days");
    }

    return suggestions.slice(0, 5);
  } catch (err) {
    console.error("[Chat AI] Error generating suggestions:", err);
    return [
      "How am I performing this month?",
      "What's my cost per lead?",
      "Show all campaigns",
    ];
  }
}
