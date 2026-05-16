#!/usr/bin/env node
// scripts/check-dashboard.mjs
//
// Headless-Chromium harness for sanity-checking the pirouette dashboard
// without leaving the terminal. Two modes:
//
//   node scripts/check-dashboard.mjs <url> [opts]
//     - default: desktop (1280x800), screenshots /tmp/pirouette-desktop.png
//     - --mobile: phone viewport (390x844, iPhone 14 Pro-ish)
//     - --selector <css>: wait for selector + screenshot just that element
//     - --click <css>: click selector after load (e.g. to open a popup)
//     - --wait <ms>: extra settle delay after load (default 800)
//     - --out <path>: override screenshot output path
//
// Also dumps console messages + page errors to stdout so JS bugs surface
// even when the visual looks fine. Exits non-zero on page errors so it
// can be wired into pre-publish smoke checks later.

import { chromium } from "playwright";
import { argv, exit } from "node:process";

// Stable path to the playwright-installed Chromium binary. Pinned because:
//   1. METR-laptop security (santa) requires the binary to be codesigned
//      with the `metr-santa-cert` identity before macOS will let it spawn
//      child processes (renderer / GPU helpers). Without the signature,
//      `browser.newPage()` fails with "Target page, context or browser
//      has been closed" as the first renderer fork is blocked.
//   2. Once signed, the signature persists on the binary on disk -- but
//      `playwright install --force` rewrites the binary and wipes the
//      signature. So this path must NEVER change unless we re-sign
//      everything underneath the .app bundle (main app + framework + 4
//      helper apps -- main, Alerts, GPU, Renderer).
//
// If playwright is upgraded and the version directory changes (currently
// chromium-1223), this constant needs updating AND the whole bundle has
// to be re-signed via:
//
//   APP="/Users/neev/Library/Caches/ms-playwright/chromium-<ver>/chrome-mac-arm64/Google Chrome for Testing.app"
//   for h in "$APP/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/"*/Helpers/*.app; do
//     codesign -f --sign "metr-santa-cert" "$h"
//   done
//   codesign -f --sign "metr-santa-cert" "$APP/Contents/Frameworks/Google Chrome for Testing Framework.framework"
//   codesign -f --sign "metr-santa-cert" "$APP"
const CHROMIUM_EXECUTABLE =
  "/Users/neev/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

function parseArgs(av) {
  const a = av.slice(2);
  const out = {
    url: a[0],
    mobile: false,
    selector: null,
    click: null,
    wait: 800,
    out: null,
  };
  for (let i = 1; i < a.length; i++) {
    if (a[i] === "--mobile") out.mobile = true;
    else if (a[i] === "--selector") out.selector = a[++i];
    else if (a[i] === "--click") out.click = a[++i];
    else if (a[i] === "--wait") out.wait = Number(a[++i]) || 800;
    else if (a[i] === "--out") out.out = a[++i];
  }
  return out;
}

const opts = parseArgs(argv);
if (!opts.url) {
  console.error("usage: node scripts/check-dashboard.mjs <url> [--mobile] [--selector <css>] [--click <css>] [--wait <ms>] [--out <path>]");
  exit(2);
}

const viewport = opts.mobile
  ? { width: 390, height: 844 } // iPhone 14 Pro-ish (logical px)
  : { width: 1280, height: 800 };
const outPath =
  opts.out ?? (opts.mobile ? "/tmp/pirouette-mobile.png" : "/tmp/pirouette-desktop.png");

const browser = await chromium.launch({
  headless: true,
  // See CHROMIUM_EXECUTABLE comment above. The default playwright launch
  // picks the chromium-headless-shell variant, which we'd then have to
  // codesign separately; pinning to the full chrome binary keeps it to
  // one signing step.
  executablePath: CHROMIUM_EXECUTABLE,
});
const ctx = await browser.newContext({ viewport, deviceScaleFactor: opts.mobile ? 2 : 1 });
const page = await ctx.newPage();

const consoleMessages = [];
const pageErrors = [];
page.on("console", (m) => {
  consoleMessages.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => {
  pageErrors.push(`${e.message}\n${e.stack ?? ""}`);
});

console.log(`navigating to ${opts.url} (viewport ${viewport.width}x${viewport.height}${opts.mobile ? ", mobile" : ""})`);
await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
await new Promise((r) => setTimeout(r, opts.wait));

if (opts.click) {
  console.log(`clicking ${JSON.stringify(opts.click)}`);
  await page.click(opts.click, { timeout: 5_000 });
  await new Promise((r) => setTimeout(r, 400));
}

const target = opts.selector ? page.locator(opts.selector) : page;
if (opts.selector) {
  await target.waitFor({ state: "visible", timeout: 5_000 });
}
await target.screenshot({ path: outPath });
console.log(`screenshot saved: ${outPath}`);

if (consoleMessages.length > 0) {
  console.log("\n--- page console ---");
  for (const m of consoleMessages) console.log(m);
}
if (pageErrors.length > 0) {
  console.log("\n--- page errors ---");
  for (const e of pageErrors) console.log(e);
}

await browser.close();
exit(pageErrors.length > 0 ? 1 : 0);
