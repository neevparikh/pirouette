/** `pru config show|path` — inspect effective merged configuration. */

import { execSync } from "node:child_process";
import { loadConfig } from "../../config.js";

export function configShow(): void {
  const { config, sources } = loadConfig();

  console.log("# config sources (later wins):");
  for (const s of sources) {
    const marker = s.exists ? "  ✓" : "  ·";
    const label = s.exists ? "loaded" : "not present";
    console.log(`${marker} ${s.path}  (${label})`);
  }
  console.log("");
  console.log("# effective config:");
  console.log(JSON.stringify(config, null, 2));
}

export function configPath(): void {
  const { sources } = loadConfig();
  for (const s of sources) {
    console.log(s.path);
  }
}

export function configEdit(): void {
  const { sources } = loadConfig();
  // Prefer editing the user-level override, not the repo default.
  const target = sources.find((s) => s.path.includes(".pirouette")) ?? sources[0];
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  try {
    execSync(`${editor} "${target.path}"`, { stdio: "inherit" });
  } catch {
    // editor exit code != 0 is fine (e.g. user quit without saving)
  }
}
