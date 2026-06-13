type GeminiRole = "user" | "model";

interface GeminiPart {
  text?: string;
}

interface GeminiContent {
  role?: GeminiRole;
  parts?: GeminiPart[];
}

interface GenerateContentInput {
  model?: string;
  contents: GeminiContent[];
  config?: {
    systemInstruction?: string;
    responseMimeType?: string;
    maxOutputTokens?: number;
    temperature?: number;
    thinkingConfig?: Record<string, unknown>;
  };
}

interface CloudflareAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CloudflareAiResponse {
  model?: string;
  text?: string;
  error?: string;
}

interface GenerateContentResult {
  text?: string;
  model?: string;
}

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function getInternalAiUrl(): string {
  const explicit = process.env.CLOUDFLARE_AI_GATEWAY_URL?.trim();
  if (explicit) return explicit;

  const publicBase =
    process.env.PUBLIC_API_URL?.trim() ||
    process.env.API_BASE_URL?.trim() ||
    process.env.PUBLIC_APP_URL?.trim();

  if (!publicBase) {
    throw new Error("Cloudflare AI is not configured. Set CLOUDFLARE_AI_GATEWAY_URL or PUBLIC_API_URL.");
  }

  return new URL("/_internal/ai/run", publicBase).toString();
}

function getInternalAiToken(): string {
  const token = process.env.CLOUDFLARE_AI_INTERNAL_TOKEN?.trim();
  if (!token) {
    throw new Error("Cloudflare AI is not configured. Set CLOUDFLARE_AI_INTERNAL_TOKEN.");
  }
  return token;
}

function contentText(content: GeminiContent): string {
  return content.parts?.map((part) => part.text ?? "").join("\n").trim() ?? "";
}

function toMessages(input: GenerateContentInput): CloudflareAiMessage[] {
  const messages: CloudflareAiMessage[] = [];
  const systemInstruction = input.config?.systemInstruction?.trim();
  if (systemInstruction) {
    messages.push({ role: "system", content: systemInstruction });
  }

  for (const content of input.contents) {
    const text = contentText(content);
    if (!text) continue;
    messages.push({
      role: content.role === "model" ? "assistant" : "user",
      content: text,
    });
  }

  return messages.length > 0 ? messages : [{ role: "user", content: "" }];
}

function mapModel(model: string | undefined, responseMimeType: string | undefined): { model: string; fast: boolean } {
  const requested = model?.toLowerCase() ?? "";
  const fast = requested.includes("flash") || responseMimeType === "application/json";
  return {
    model:
      (fast ? process.env.CLOUDFLARE_AI_FAST_MODEL?.trim() : process.env.CLOUDFLARE_AI_MODEL?.trim()) ||
      process.env.CLOUDFLARE_AI_MODEL?.trim() ||
      DEFAULT_MODEL,
    fast,
  };
}

function buildCloudflareInput(input: GenerateContentInput): Record<string, unknown> {
  const cfInput: Record<string, unknown> = {
    messages: toMessages(input),
  };

  if (input.config?.maxOutputTokens) {
    cfInput.max_tokens = input.config.maxOutputTokens;
  }

  if (typeof input.config?.temperature === "number") {
    cfInput.temperature = input.config.temperature;
  }

  if (input.config?.responseMimeType === "application/json") {
    cfInput.response_format = { type: "json_object" };
  }

  return cfInput;
}

async function runCloudflareAi(input: GenerateContentInput): Promise<GenerateContentResult> {
  const { model, fast } = mapModel(input.model, input.config?.responseMimeType);
  const response = await fetch(getInternalAiUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${getInternalAiToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      fast,
      input: buildCloudflareInput(input),
    }),
  });

  const body = await response.json() as CloudflareAiResponse;
  if (!response.ok) {
    throw new Error(body.error || `Cloudflare AI request failed with ${response.status}`);
  }

  return {
    model: body.model,
    text: body.text ?? "",
  };
}

export const ai = {
  models: {
    generateContent(input: GenerateContentInput): Promise<GenerateContentResult> {
      return runCloudflareAi(input);
    },
    async *generateContentStream(input: GenerateContentInput): AsyncGenerator<GenerateContentResult> {
      yield await runCloudflareAi(input);
    },
  },
};
