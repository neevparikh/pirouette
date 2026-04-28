#!/usr/bin/env node
/**
 * Generate pirouette's theme assets from a base16 scheme directory.
 *
 * Matches the CSS-variable naming used by neevparikh.github.io's base16-tailwind
 * setup (`invert: true`, `prefix: "base16"`, `system: "base24"`) so the two
 * sites share a palette and the theme picker feels identical.
 *
 * Outputs:
 *   src/web/themes.css   — one `.<slug> { --color-base16-*: R G B; ... }` block
 *                          per scheme. Variables read by the Tailwind config
 *                          in index.html via `rgb(var(--color-base16-red))` etc.
 *   src/web/themes.json  — `[ { slug, name, variant, system, author } ]` for
 *                          the picker UI.
 *
 * Run once after pulling new schemes; outputs are checked in.
 *
 * Usage:
 *   node scripts/generate-themes.mjs [schemes-dir]
 *
 * Default schemes-dir: ~/repos/neevparikh.github.io/src/base16-tailwind/schemes
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_SCHEMES_DIR = path.join(
  homedir(),
  "repos",
  "neevparikh.github.io",
  "src",
  "base16-tailwind",
  "schemes",
);
const schemesDir = process.argv[2] ?? DEFAULT_SCHEMES_DIR;
const webDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src", "web");
const cssOut = path.join(webDir, "themes.css");
const jsonOut = path.join(webDir, "themes.json");

// ---- tiny yaml parser for base16 scheme files -----------------------------
// The YAMLs are flat + uniform (see e.g. schemes/base24/softstack-dark.yaml).
// Full yaml parsing is overkill; this handles exactly the shape we need.
function parseSchemeYaml(text) {
  const lines = text.split("\n");
  const scheme = { palette: {} };
  let inPalette = false;
  for (const raw of lines) {
    // Strip YAML trailing comments. Key: `#` must be preceded by whitespace
    // so we don't swallow `#hex` color values.
    const line = raw.replace(/\s#.*$/, "").trimEnd();
    if (!line) continue;
    if (/^palette:\s*$/.test(line)) {
      inPalette = true;
      continue;
    }
    if (inPalette) {
      const m = line.match(/^\s+(base[0-9a-fA-F]{2}):\s*"([^"]+)"/);
      if (m) scheme.palette[m[1].toLowerCase()] = m[2];
    } else {
      const m = line.match(/^(\w+):\s*"([^"]+)"/);
      if (m) scheme[m[1]] = m[2];
    }
  }
  return scheme;
}

// ---- hex → "R G B" space-separated triple -------------------------------
function hexToTriple(hex) {
  const h = hex.replace(/^#/, "").trim();
  if (h.length !== 6) throw new Error(`bad hex color: ${hex}`);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

// ---- scheme → CSS var record --------------------------------------------
const NAMED = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];

function schemeToVars(scheme) {
  const p = scheme.palette;
  const vars = {};

  // base00..base07 → base16-100..800 (invert=true means base00 becomes the
  // smallest-numbered variable, which is "bg" in dark themes / "fg" in light.
  // This matches how Tailwind's `bg-base16-100` resolves to the bg color.)
  for (let i = 0; i < 8; i++) {
    const key = "base" + i.toString(16).padStart(2, "0").toLowerCase();
    const hex = p[key];
    if (!hex) continue;
    vars[`--color-base16-${(i + 1) * 100}`] = hexToTriple(hex);
  }

  // base08..base0F → named colors.
  for (let i = 0; i < 8; i++) {
    const key = "base" + (8 + i).toString(16).padStart(2, "0").toLowerCase();
    const hex = p[key];
    if (!hex) continue;
    vars[`--color-base16-${NAMED[i]}`] = hexToTriple(hex);
  }

  // base24 brights.
  if (scheme.system === "base24") {
    // base10/base11 → 100-lighter / 100-lightest (invert=true convention).
    if (p.base10) vars[`--color-base16-100-lighter`] = hexToTriple(p.base10);
    if (p.base11) vars[`--color-base16-100-lightest`] = hexToTriple(p.base11);
    // base12..base17 → bright variants of red, orange, yellow, green, cyan, blue.
    for (let i = 0; i < 6; i++) {
      const key = "base" + (0x12 + i).toString(16).padStart(2, "0").toLowerCase();
      const hex = p[key];
      if (!hex) continue;
      vars[`--color-base16-${NAMED[i]}-bright`] = hexToTriple(hex);
    }
  }

  return vars;
}

// ---- slug from system + name -------------------------------------------
function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---- walk schemes dir ---------------------------------------------------
function walkYamls(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      out.push(...walkYamls(p));
    } else if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
      out.push(p);
    }
  }
  return out;
}

// ---- main ---------------------------------------------------------------
function main() {
  const files = walkYamls(schemesDir);
  console.log(`[generate-themes] reading ${files.length} scheme files from ${schemesDir}`);

  const schemes = [];
  const dedupe = new Set();

  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      console.warn(`  skip (unreadable): ${file}`);
      continue;
    }
    let scheme;
    try {
      scheme = parseSchemeYaml(raw);
    } catch (err) {
      console.warn(`  skip (parse error): ${file}: ${err.message}`);
      continue;
    }
    if (!scheme.name || !scheme.system) {
      console.warn(`  skip (missing name/system): ${file}`);
      continue;
    }
    const slug = `${scheme.system}-${slugify(scheme.name)}`;
    if (dedupe.has(slug)) continue;
    dedupe.add(slug);

    let vars;
    try {
      vars = schemeToVars(scheme);
    } catch (err) {
      console.warn(`  skip (bad palette): ${file}: ${err.message}`);
      continue;
    }

    schemes.push({
      slug,
      name: scheme.name,
      variant: scheme.variant ?? "dark",
      system: scheme.system,
      author: scheme.author ?? "",
      vars,
    });
  }

  // Stable sort: base24 first (brighter palettes), then by name, so the picker
  // list is deterministic across runs.
  schemes.sort((a, b) => {
    if (a.system !== b.system) return a.system === "base24" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // --- CSS output ---
  const header = [
    "/*",
    " * Generated by scripts/generate-themes.mjs from base16/base24 scheme YAMLs.",
    " * DO NOT EDIT DIRECTLY \u2014 regenerate with `node scripts/generate-themes.mjs`.",
    ` * ${schemes.length} themes.`,
    " */",
    "",
  ].join("\n");

  const blocks = schemes.map((s) => {
    const lines = Object.entries(s.vars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    return `.${s.slug} {\n${lines}\n}`;
  });
  writeFileSync(cssOut, header + blocks.join("\n\n") + "\n");
  console.log(`[generate-themes] wrote ${cssOut} (${schemes.length} themes)`);

  // --- JSON manifest for the picker ---
  const manifest = schemes.map(({ slug, name, variant, system, author }) => ({
    slug,
    name,
    variant,
    system,
    author,
  }));
  writeFileSync(jsonOut, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[generate-themes] wrote ${jsonOut}`);
}

main();
