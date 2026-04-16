import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DB_DIR = path.join(REPO_ROOT, "lib", "db");
const DRIZZLE_KIT_BIN = path.join(DB_DIR, "node_modules", ".bin", "drizzle-kit");

export async function syncSchemaFromDrizzle(): Promise<void> {
  console.log("[SchemaSync] Running drizzle-kit push --force to sync DB with canonical schema…");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      DRIZZLE_KIT_BIN,
      ["push", "--force", "--config", "./drizzle.config.ts"],
      {
        cwd: DB_DIR,
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
        reject(new Error(`drizzle-kit push exited with code ${code}. Output:\n${chunks.join("")}`));
      }
    });
  });
}
