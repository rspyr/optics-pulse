import { ai } from "@workspace/integrations-gemini-ai";

export interface ParsedFilter {
  source?: string;
  leadType?: string;
  status?: string;
  assignedTo?: string;
  disposition?: string;
  dateRange?: { startDate: string; endDate: string };
}

interface FilterContext {
  sources: string[];
  leadTypes: string[];
  statuses: string[];
  salespeople: string[];
  dispositions: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function matchSalesperson(input: string, salespeople: string[]): string | undefined {
  const lower = input.toLowerCase();
  const exact = salespeople.find(s => s.toLowerCase() === lower);
  if (exact) return exact;
  const partial = salespeople.find(s => {
    const parts = s.toLowerCase().split(/\s+/);
    return parts.some(p => p === lower);
  });
  return partial;
}

function fuzzyMatch(input: string, options: string[]): string | undefined {
  const lower = input.toLowerCase();
  const exact = options.find(o => o.toLowerCase() === lower);
  if (exact) return exact;
  const contains = options.find(o => o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()));
  return contains;
}

export async function parseFilterQuery(
  query: string,
  context: FilterContext,
): Promise<ParsedFilter> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are a filter parser for a leads/CRM dashboard. Given a natural language query, extract structured filter values to apply to the leads table.

Here are ALL the available filter values for this client. You MUST only return values from these exact lists:

Sources (lead source/channel — where the lead came from): ${JSON.stringify(context.sources)}
Lead Types (campaign/funnel type — how the lead entered): ${JSON.stringify(context.leadTypes)}
Statuses (lead pipeline status): ${JSON.stringify(context.statuses)}
Salespeople (assigned salesperson): ${JSON.stringify(context.salespeople)}
Dispositions (call/contact outcome): ${JSON.stringify(context.dispositions)}

Today's date is ${today}.

IMPORTANT: The same word can exist in multiple filter categories. Each word in the query may map to a DIFFERENT filter field. For example:
- "google direct leads" → source: "Google Ads", leadType: "Direct" (two separate filters)
- "new organic leads" → status: "new", leadType: "organic" (two separate filters)
- "booked meta leads" → status: "booked", source: "Meta Leads" (two separate filters)

Instructions:
1. Extract ALL filter values mentioned in the query — multiple filters can be set simultaneously.
2. For each keyword, determine which filter category it best belongs to by checking the available values in each list.
3. For assignedTo, match by first name, last name, or full name against the Salespeople list.
4. For dateRange, extract temporal references like "this week", "last 7 days", "this month", "today", etc. Return as {"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD"}.
5. Only include fields that the user's query references. Omit unmentioned fields.
6. Return the exact value string from the list (preserve original casing).
7. If you truly cannot match the query to any filter at all, return {}.

Return ONLY a valid JSON object. No markdown, no explanation, no extra text.

Query: "${query}"`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as ParsedFilter;
    const result: ParsedFilter = {};

    if (parsed.source) {
      const matched = fuzzyMatch(parsed.source, context.sources);
      if (matched) result.source = matched;
    }
    if (parsed.leadType) {
      const matched = fuzzyMatch(parsed.leadType, context.leadTypes);
      if (matched) result.leadType = matched;
    }
    if (parsed.status) {
      const matched = fuzzyMatch(parsed.status, context.statuses);
      if (matched) result.status = matched;
    }
    if (parsed.assignedTo) {
      const matched = matchSalesperson(parsed.assignedTo, context.salespeople);
      if (matched) result.assignedTo = matched;
    }
    if (parsed.disposition) {
      const matched = fuzzyMatch(parsed.disposition, context.dispositions);
      if (matched) result.disposition = matched;
    }
    if (parsed.dateRange?.startDate && parsed.dateRange?.endDate) {
      const { startDate, endDate } = parsed.dateRange;
      if (DATE_RE.test(startDate) && DATE_RE.test(endDate) && startDate <= endDate) {
        result.dateRange = { startDate, endDate };
      }
    }

    return result;
  } catch {
    return {};
  }
}
