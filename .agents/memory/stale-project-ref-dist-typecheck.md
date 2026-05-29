---
name: Artifact typecheck resolves @workspace/* to source, not built dist
description: Why a bare `tsc --noEmit` in an artifact can show phantom "property does not exist" errors, and the tsconfig wiring that prevents it
---

Artifacts import `@workspace/*` libs. The repo is set up so that TypeScript should
resolve those imports to lib **source** (`lib/<pkg>/src/*.ts`) during typecheck:
- `tsconfig.base.json` sets `customConditions: ["workspace"]`
- each lib `package.json` exports `".": "./src/index.ts"`

**The footgun:** if an artifact's `tsconfig.json` also lists composite
`references` to those libs, a non-build `tsc -p tsconfig.json --noEmit` resolves
the imports through the referenced projects' BUILT output instead
(`lib/<pkg>/dist/*.d.ts`). That `dist` (and `tsconfig.tsbuildinfo`) is gitignored
and can be stale — built before a new column/field was added — so the bare
command reports phantom `Property 'X' does not exist on type ...` errors even
though the committed source is correct. (If dist is missing entirely you instead
get `TS6305: Output file has not been built from source file`.)

**Rule:** an artifact tsconfig that wants a reliable standalone `tsc --noEmit`
must NOT carry `references` to the workspace libs — rely on
`customConditions: ["workspace"]` + the libs' `src` exports so it type-checks
against live source. `references` belong in build-mode flows (`tsc -b`), not in
the bare typecheck config.

**Why:** removing `references` from `artifacts/api-server/tsconfig.json` +
`tsconfig.test.json` fixed a red type check whose source was already correct;
the errors came purely from stale referenced `dist`.

**How to apply:** before "fixing" a missing-property error in an artifact route,
confirm the lib SOURCE already has it (`git show HEAD:lib/db/src/...`). If source
is correct, the problem is tsconfig wiring / stale dist, not the code. The
canonical `pnpm run typecheck` (which runs `tsc -b` first) is always the source
of truth over a bare `tsc --noEmit`.
