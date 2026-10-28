import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every module reachable from app.js through relative imports. */
function moduleGraph(entry) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const src = readFileSync(resolve(webDir, name), "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"\.\/([\w-]+\.js)"/g)) visit(m[1]);
    for (const m of src.matchAll(/(?:^|\n)\s*import\s+"\.\/([\w-]+\.js)"/g)) visit(m[1]);
  };
  visit(entry);
  return seen;
}

describe("index.html module preloads", () => {
  it("lists every module app.js loads", () => {
    const html = readFileSync(resolve(webDir, "index.html"), "utf8");
    const preloaded = new Set([...html.matchAll(/<link rel="modulepreload" href="([\w-]+\.js)"/g)].map((m) => m[1]));
    expect([...preloaded].sort()).toEqual([...moduleGraph("app.js")].sort());
  });
});
