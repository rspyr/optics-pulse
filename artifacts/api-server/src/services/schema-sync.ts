import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Walk up from `process.cwd()` looking for `pnpm-workspace.yaml` to find
// the repo root. This works in both environments:
//   - dev (`pnpm --filter @workspace/api-server run dev`) runs with
//     cwd = `artifacts/api-server`
//   - production (`node artifacts/api-server/dist/index.cjs` per
//     `.replit-artifact/artifact.toml`) runs with cwd = repo root
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `[SchemaSync] Could not locate pnpm-workspace.yaml walking up from ${process.cwd()}.`,
  );
}

function resolveDbDir(): string {
  return path.resolve(findRepoRoot(), "lib", "db");
}

function resolveDrizzleKitBin(dbDir: string): string | null {
  const candidates = [
    path.join(dbDir, "node_modules", ".bin", "drizzle-kit"),
    path.join(process.cwd(), "node_modules", ".bin", "drizzle-kit"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Sync the DB schema from the canonical Drizzle definitions in
 * `lib/db/src/schema/` using `drizzle-kit push --force`. Runs at
 * api-server startup, before the server accepts traffic, so every
 * deploy automatically picks up pending schema changes.
 *
 * Data-aware migrations (backfills, constraint tightening on existing
 * rows) must run BEFORE this step, in `one-time-migrations.ts`, so that
 * `push` does not fail trying to e.g. add a NOT NULL column on a
 * populated table.
 */
export async function syncSchemaFromDrizzle(): Promise<void> {
  const dbDir = resolveDbDir();

  if (!existsSync(dbDir)) {
    throw new Error(
      `[SchemaSync] Expected lib/db at ${dbDir} but it does not exist. ` +
        `cwd=${process.cwd()} — check api-server launch cwd.`,
    );
  }

  const bin = resolveDrizzleKitBin(dbDir);
  if (!bin) {
    throw new Error(
      `[SchemaSync] drizzle-kit binary not found in lib/db/node_modules or root node_modules. ` +
        `Ensure devDependencies are installed in this environment so schema sync can run.`,
    );
  }

  console.log(`[SchemaSync] Running ${bin} push --force (cwd=${dbDir})…`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      bin,
      ["push", "--force", "--config", "./drizzle.config.ts"],
      {
        cwd: dbDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const chunks: string[] = [];
    child.stdout?.on("data", (d) => {
      const s = d.toString();
      chunks.push(s);
      process.stdout.write(`[SchemaSync] ${s}`);
    });
    child.stderr?.on("data", (d) => {
      const s = d.toString();
      chunks.push(s);
      process.stderr.write(`[SchemaSync] ${s}`);
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn drizzle-kit: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log("[SchemaSync] drizzle-kit push completed successfully.");
        resolve();
      } else {
        reject(
          new Error(
            `drizzle-kit push exited with code ${code}. Output:\n${chunks.join("")}`,
          ),
        );
      }
    });
  });
}
