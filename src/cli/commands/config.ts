/** `pru config show|path` — inspect effective merged configuration. */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadConfig, userConfigPath } from "../../config.js";

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
  // Edit the active user-override path (respects --config / $PIROUETTE_CONFIG).
  // We deliberately don't fall back to the repo's pirouette.toml -- editing
  // that would leak personal values into the published package.
  const targetPath = userConfigPath();
  // If the active path doesn't exist yet (e.g. user did `pru --config ec2.toml
  // config edit` to create a fresh one), seed an empty file so the editor
  // has something to open.
  if (!existsSync(targetPath)) {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, "", { mode: 0o600 });
  }
  const target = { path: targetPath };
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
