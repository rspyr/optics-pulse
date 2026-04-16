#!/bin/bash
set -e

# Install workspace dependencies. No database work happens here: the
# api-server runs its own additive, tracked schema migrations on startup
# (see artifacts/api-server/src/services/schema-migrations.ts).
#
# `pnpm --filter db push` (drizzle-kit push) is intentionally NOT invoked
# here. Push generates destructive ALTER TABLE statements whenever the
# Drizzle journal drifts from the actual database state, which has broken
# production in the past. Use the startup migration runner for prod, and
# run `pnpm --filter @workspace/db push` manually in a dev database only.
pnpm install --frozen-lockfile
