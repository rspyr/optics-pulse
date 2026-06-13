interface Env {
  ASSETS: Fetcher;
  API_ORIGIN?: string;
}

const API_PATH_PREFIXES = ["/api"];

function normalizeOrigin(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function shouldProxyToApi(pathname: string): boolean {
  return API_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function buildProxyRequest(request: Request, targetUrl: URL, apiOrigin: string): Request {
  const sourceUrl = new URL(request.url);
  const headers = new Headers(request.headers);
  const originalOrigin = headers.get("origin");
  headers.delete("host");
  headers.set("x-forwarded-host", sourceUrl.host);
  headers.set("x-forwarded-proto", sourceUrl.protocol.replace(":", ""));
  headers.set("x-optics-edge", "cloudflare-worker");
  if (originalOrigin) {
    headers.set("x-original-origin", originalOrigin);
  }

  // Socket.IO's server-side CORS check runs before the browser sees the
  // proxied response. During the Replit bridge, use the backend origin for the
  // handshake while keeping normal request origins intact for tracker routes.
  if (sourceUrl.pathname.startsWith("/api/socket.io")) {
    headers.set("origin", apiOrigin);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return new Request(targetUrl, init);
}

async function proxyApiRequest(request: Request, env: Env): Promise<Response> {
  const apiOrigin = normalizeOrigin(env.API_ORIGIN);
  if (!apiOrigin) {
    return Response.json(
      {
        error: "API_ORIGIN is not configured for this Cloudflare Worker.",
      },
      { status: 503 },
    );
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, apiOrigin);
  return fetch(buildProxyRequest(request, targetUrl, apiOrigin));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_edge/health") {
      return Response.json({
        status: "ok",
        apiOriginConfigured: Boolean(normalizeOrigin(env.API_ORIGIN)),
      });
    }

    if (shouldProxyToApi(url.pathname)) {
      return proxyApiRequest(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
