/** `pru config show|path` — inspect effective merged configuration. */

import { spawnSync } from "node:child_process";
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
  const editorRaw = process.env.VISUAL ?? process.env.EDITOR ?? "vi";

  // Run via spawnSync with an explicit arg array (shell: false) so that
  // an EDITOR value containing shell metacharacters is parsed by us, not
  // an intermediate shell. Splitting on whitespace handles common cases
  // like `EDITOR="code -w"` or `EDITOR="vim --noplugin"`.
  const parts = editorRaw.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    console.error("$EDITOR / $VISUAL is empty");
    process.exitCode = 1;
    return;
  }
  const [bin, ...args] = parts;
  const result = spawnSync(bin, [...args, target.path], { stdio: "inherit", shell: false });
  // exit-code != 0 (or signal) is fine — user may have quit without saving
  // or the editor may have exited normally with a non-zero status.
  if (result.error) {
    console.error(`Failed to launch editor (${bin}): ${result.error.message}`);
    process.exitCode = 1;
  }
}
