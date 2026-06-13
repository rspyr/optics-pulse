# Cloudflare Workers Migration

Optics Pulse is moving to Cloudflare Workers with static assets. The Worker is the public edge entrypoint: it serves the React app and proxies `/api/*` to the currently active backend.

## Deployment Shape

- Worker name: `optics-pulse`
- Static assets: `artifacts/marketing-os/dist/public`
- Edge health check: `/_edge/health`
- Backend target setting: `API_ORIGIN`

During the Replit-to-Neon migration, `API_ORIGIN` should point at the current Replit backend origin, not the public client-facing domain. For the current bridge, that means `https://hvaclaunch-optics.replit.app`, because `optics.hvaclaunch.ai` is the public domain we plan to move to Cloudflare. After the Neon-backed backend is live, change `API_ORIGIN` to the new backend origin and redeploy or update the Worker secret.

## Build

Build the frontend for same-origin API calls:

```bash
PORT=5173 BASE_PATH=/ VITE_API_URL= pnpm --filter @workspace/marketing-os run build
```

## Deploy

Wrangler currently requires Node 22 or newer.

```bash
pnpm dlx wrangler deploy
```

## Required Cloudflare Setting

Set `API_ORIGIN` to the backend origin, without a trailing slash. Examples:

```bash
printf "%s" "https://your-current-backend.example.com" | pnpm dlx wrangler secret put API_ORIGIN
```

Do not point `API_ORIGIN` at the Worker URL itself.

## Backend Worker/Container Notes

- Backend Worker name: `optics-pulse-app`
- Backend URL: `https://optics-pulse-app.aaron-7dc.workers.dev`
- Cloudflare AI is configured with the `AI` binding and an internal-only token-protected route at `/_internal/ai/run`.
- The old Replit Gemini integration secrets are intentionally not required on Cloudflare. The existing AI client package now routes those calls through Cloudflare Workers AI.
- Expo push is intentionally disabled on Cloudflare with `DISABLE_EXPO_PUSH=true`. Native Swift push should use APNs, and the APNs private key is stored as a Cloudflare secret.
- Background jobs remain disabled with `DISABLE_BACKGROUND_JOBS=true` until final data cutover/backfill checks are complete.
