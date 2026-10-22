import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

for (const file of readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".test.ts")).sort()) {
  const path = fileURLToPath(new URL(file, import.meta.url));
  const result = spawnSync(process.execPath, ["--experimental-transform-types", path], { stdio: "inherit" });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
