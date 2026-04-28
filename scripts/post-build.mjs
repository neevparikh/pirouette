#!/usr/bin/env node
// Post-build tasks:
//   1. Copy src/web/ -> dist/web/ (static assets, not TypeScript). Picks up
//      vendor/ already populated by `scripts/vendor.mjs` (run earlier in
//      the build pipeline).
//   2. Make dist/cli/index.js executable + add shebang (for the `bin` entry).

import { chmodSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const srcWeb = path.join(repo, "src", "web");
const distWeb = path.join(repo, "dist", "web");
const cliIndex = path.join(repo, "dist", "cli", "index.js");

// 1. Copy web assets (excluding test files; vendor/ comes along automatically)
if (existsSync(srcWeb)) {
  cpSync(srcWeb, distWeb, {
    recursive: true,
    filter: (src) => !src.includes("__tests__") && !src.endsWith(".test.js"),
  });
  console.log(`  copied ${srcWeb} -> ${distWeb}`);
}

// 2. Add shebang to CLI entry + make executable
if (existsSync(cliIndex)) {
  const content = readFileSync(cliIndex, "utf8");
  if (!content.startsWith("#!")) {
    writeFileSync(cliIndex, "#!/usr/bin/env node\n" + content);
  }
  chmodSync(cliIndex, 0o755);
  console.log(`  prepared bin: ${cliIndex}`);
}
