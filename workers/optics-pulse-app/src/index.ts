import { Container, getContainer } from "@cloudflare/containers";

type RuntimeEnv = Record<string, unknown> & {
  ASSETS: Fetcher;
  AI: {
    run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  OPTICS_PULSE_API: DurableObjectNamespace<OpticsPulseApiContainer>;
  API_CONTAINER_NAME?: string;
  APP_ORIGINS?: string;
  APP_ALLOWED_ORIGINS?: string;
  CORS_ORIGINS?: string;
  API_BASE_URL?: string;
  PUBLIC_API_URL?: string;
  PUBLIC_APP_URL?: string;
  CLOUDFLARE_AI_INTERNAL_TOKEN?: string;
  CLOUDFLARE_AI_MODEL?: string;
  CLOUDFLARE_AI_FAST_MODEL?: string;
};

const API_PATH_PREFIXES = ["/api"];
const CONTAINER_PORT = 8080;
const DEFAULT_CONTAINER_NAME = "primary";
const BINDING_KEYS = new Set(["AI", "ASSETS", "OPTICS_PULSE_API"]);
const INTERNAL_AI_PATH = "/_internal/ai/run";
const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shouldRouteToContainer(pathname: string): boolean {
  return API_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function buildContainerEnv(env: RuntimeEnv): Record<string, string> {
  const containerEnv: Record<string, string> = {
    NODE_ENV: "production",
    PORT: String(CONTAINER_PORT),
  };

  for (const [key, value] of Object.entries(env)) {
    if (BINDING_KEYS.has(key)) continue;
    const normalized = stringValue(value);
    if (normalized) {
      containerEnv[key] = normalized;
    }
  }

  const origins = stringValue(env.APP_ALLOWED_ORIGINS) ?? stringValue(env.APP_ORIGINS) ?? stringValue(env.CORS_ORIGINS);
  if (origins) {
    containerEnv.APP_ALLOWED_ORIGINS = containerEnv.APP_ALLOWED_ORIGINS ?? origins;
    containerEnv.CORS_ORIGINS = containerEnv.CORS_ORIGINS ?? origins;
  }

  const publicUrl =
    stringValue(env.PUBLIC_APP_URL) ??
    stringValue(env.API_BASE_URL) ??
    stringValue(env.PUBLIC_API_URL);
  if (publicUrl) {
    containerEnv.APP_PUBLIC_URL = containerEnv.APP_PUBLIC_URL ?? publicUrl;
    containerEnv.PUBLIC_APP_URL = containerEnv.PUBLIC_APP_URL ?? publicUrl;
    containerEnv.API_BASE_URL = containerEnv.API_BASE_URL ?? publicUrl;
    containerEnv.PUBLIC_API_URL = containerEnv.PUBLIC_API_URL ?? publicUrl;
  }

  return containerEnv;
}

function buildContainerRequest(request: Request): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);

  headers.delete("host");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set("x-optics-edge", "cloudflare-container-worker");

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return new Request(request.url, init);
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function isAuthorizedInternalRequest(request: Request, expectedToken: string | undefined): Promise<boolean> {
  if (!expectedToken) return false;
  const header = request.headers.get("authorization") ?? "";
  const actualToken = header.startsWith("Bearer ") ? header.slice(7) : request.headers.get("x-optics-ai-token") ?? "";
  const [actualHash, expectedHash] = await Promise.all([digest(actualToken), digest(expectedToken)]);

  let mismatch = actualHash.length ^ expectedHash.length;
  for (let i = 0; i < expectedHash.length; i++) {
    mismatch |= (actualHash[i] ?? 0) ^ expectedHash[i];
  }
  return mismatch === 0;
}

function extractAiText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";

  const record = result as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  if (typeof record.result === "string") return record.result;

  const nestedResult = record.result;
  if (nestedResult && typeof nestedResult === "object") {
    return extractAiText(nestedResult);
  }

  const choices = record.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string") return message.content;
    if (typeof first?.text === "string") return first.text;
  }

  return JSON.stringify(result);
}

async function handleInternalAiRequest(request: Request, env: RuntimeEnv): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!(await isAuthorizedInternalRequest(request, stringValue(env.CLOUDFLARE_AI_INTERNAL_TOKEN)))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json() as {
    model?: string;
    input?: Record<string, unknown>;
    fast?: boolean;
  };

  const model =
    body.model ??
    (body.fast ? stringValue(env.CLOUDFLARE_AI_FAST_MODEL) : stringValue(env.CLOUDFLARE_AI_MODEL)) ??
    stringValue(env.CLOUDFLARE_AI_MODEL) ??
    DEFAULT_AI_MODEL;

  try {
    const result = await env.AI.run(model, body.input ?? {});
    return Response.json({
      model,
      text: extractAiText(result),
      result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cloudflare AI request failed";
    console.error("[CloudflareAI] request failed", { model, message });
    return Response.json({ error: message }, { status: 502 });
  }
}

export class OpticsPulseApiContainer extends Container<RuntimeEnv> {
  defaultPort = CONTAINER_PORT;
  sleepAfter = "10m";
  enableInternet = true;

  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env, {
      defaultPort: CONTAINER_PORT,
      sleepAfter: "10m",
      enableInternet: true,
      envVars: buildContainerEnv(env),
    });
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_edge/health") {
      return Response.json({
        status: "ok",
        backend: "container",
        containerBindingConfigured: Boolean(env.OPTICS_PULSE_API),
        aiBindingConfigured: Boolean(env.AI),
        backgroundJobsDisabled: stringValue(env.DISABLE_BACKGROUND_JOBS) === "true",
      });
    }

    if (url.pathname === INTERNAL_AI_PATH) {
      return handleInternalAiRequest(request, env);
    }

    if (shouldRouteToContainer(url.pathname)) {
      const containerName = stringValue(env.API_CONTAINER_NAME) ?? DEFAULT_CONTAINER_NAME;
      const container = getContainer(env.OPTICS_PULSE_API, containerName);
      return container.fetch(buildContainerRequest(request));
    }

    return env.ASSETS.fetch(request);
  },
};
