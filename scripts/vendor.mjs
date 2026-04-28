#!/usr/bin/env node
// Vendor third-party browser libraries into src/web/vendor/ so the
// dashboard runs without CDN dependencies. Output is gitignored;
// regenerate with `npm run vendor` (or implicitly via `npm run build` /
// `npm run dev`).
//
// Why src/web/vendor/ and not dist/web/vendor/?
//   - Dev mode (`npm run dev` -> tsx) serves src/web/ directly.
//   - Build mode (`npm run build`) does src/web -> dist/web copy after
//     this script, so the vendor files flow through to dist/.
// Single source of truth = src/web/vendor/, both code paths see it.
//
// What's vendored:
//   - marked.min.js              (npm: marked)
//   - marked-highlight.umd.js    (npm: marked-highlight)
//   - purify.min.js              (npm: dompurify)
//   - highlight.umd.js           (npm: highlight.js, bundled with esbuild
//                                 since the package ships only CJS)
//   - tailwindcss.min.js         (committed at vendor/tailwindcss-3.4.17.min.js
//                                 since Tailwind v3 has no equivalent npm
//                                 distribution form)

import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const outDir = path.join(repo, "src", "web", "vendor");
const repoVendor = path.join(repo, "vendor");
const nodeModules = path.join(repo, "node_modules");

mkdirSync(outDir, { recursive: true });

function copyFromNodeModules(relPath, destName) {
  const src = path.join(nodeModules, relPath);
  if (!existsSync(src)) {
    throw new Error(
      `vendor copy failed: ${src} not found. Run \`npm install\` and verify the package version.`,
    );
  }
  cpSync(src, path.join(outDir, destName));
  console.log(`  vendored ${destName} (from ${relPath})`);
}

copyFromNodeModules("marked/marked.min.js", "marked.min.js");
copyFromNodeModules("marked-highlight/lib/index.umd.js", "marked-highlight.umd.js");
copyFromNodeModules("dompurify/dist/purify.min.js", "purify.min.js");

// highlight.js: package ships only CJS, no single-file UMD. Bundle the
// `common` entry (~36 most-used languages, matches what the jsDelivr CDN
// serves) into a self-contained IIFE that defines window.hljs.
const highlightSrc = path.join(nodeModules, "highlight.js", "lib", "common.js");
if (!existsSync(highlightSrc)) {
  throw new Error(`vendor bundle failed: ${highlightSrc} not found`);
}
esbuild.buildSync({
  entryPoints: [highlightSrc],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "hljs",
  platform: "browser",
  outfile: path.join(outDir, "highlight.umd.js"),
  logLevel: "warning",
});
console.log(`  bundled highlight.umd.js (highlight.js/lib/common.js via esbuild)`);

// Tailwind v3 CDN runtime (committed; see vendor/README.md for source URL).
const tailwindSrc = path.join(repoVendor, "tailwindcss-3.4.17.min.js");
if (!existsSync(tailwindSrc)) {
  throw new Error(
    `vendor copy failed: ${tailwindSrc} not found. See vendor/README.md to re-fetch.`,
  );
}
cpSync(tailwindSrc, path.join(outDir, "tailwindcss.min.js"));
console.log(`  vendored tailwindcss.min.js (from vendor/tailwindcss-3.4.17.min.js)`);
