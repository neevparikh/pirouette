#!/usr/bin/env node
// Browser regression check for the transcript scrollbar, using the dashboard's
// actual styles (no backend or external assets needed).
//   node scripts/check-scrollbar.mjs [chromium|firefox|webkit ...]
// Defaults to Chromium. Install browsers with `npx playwright install`.
// Firefox's headless harness forcibly hides scrollbars, so run it headed:
//   xvfb-run -a env HEADLESS=0 node scripts/check-scrollbar.mjs firefox webkit
// CHROMIUM_PATH may point to an alternate Chromium executable.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
const styles = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const themes = await readFile(new URL("../src/web/themes.css", import.meta.url), "utf8");
const engines = { chromium, firefox, webkit };
const names = process.argv.slice(2);

for (const name of names.length ? names : ["chromium"]) {
  assert.ok(engines[name], `unknown browser: ${name}`);
  const browser = await engines[name].launch({
    headless: process.env.HEADLESS !== "0",
    ...(name === "chromium" ? {
      ignoreDefaultArgs: ["--hide-scrollbars"],
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // The fixture only supplies geometry/content; scrollbar rules come from
    // index.html. Its very long content exercises the minimum thumb height.
    await page.setContent(`<!doctype html><html class="base24-softstack-dark">
      <style>${themes}</style><style>${styles}</style>
      <style>
        body { margin: 0; }
        #messages { width: 100%; height: 600px; overflow: auto; }
        #content { height: 100000px; }
        #secondary, #nested { width: 150px; height: 80px; overflow: auto; }
      </style>
      <div id="messages"><div id="content">Transcript
        <div id="nested"><div style="height: 1000px">Tool output</div></div>
      </div></div>
      <div id="secondary"><div style="height: 1000px">Sidebar</div></div>
    </html>`);

    const metrics = () => page.locator("#messages").evaluate((el) => {
      const style = getComputedStyle(el);
      const thumb = getComputedStyle(el, "::-webkit-scrollbar-thumb");
      return {
        custom: CSS.supports("selector(::-webkit-scrollbar)"),
        width: style.scrollbarWidth,
        gutter: el.offsetWidth - el.clientWidth,
        minThumb: thumb.minHeight,
        thumbColor: thumb.backgroundColor,
        trackColor: getComputedStyle(el, "::-webkit-scrollbar-track").backgroundColor,
        scrollTop: el.scrollTop,
      };
    });
    const initial = await metrics();
    assert.equal(initial.width, "auto", `${name}: no thin transcript scrollbar`);
    if (initial.custom) {
      assert.equal(initial.gutter, 20, `${name}: 20px grab target`);
      assert.equal(initial.minThumb, "48px", `${name}: minimum thumb height`);
      assert.notEqual(initial.thumbColor, initial.trackColor, `${name}: visible thumb`);
    }
    for (const id of ["secondary", "nested"]) {
      assert.equal(await page.locator(`#${id}`).evaluate((el) => getComputedStyle(el).scrollbarWidth),
        "thin", `${name}: ${id} scrollbar stays compact`);
    }

    if (initial.custom) {
      // Grab below the tiny proportional thumb a 100,000px transcript would
      // normally have. The 48px minimum should make this part draggable too.
      const x = 1280 - initial.gutter / 2;
      const y = 36;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, 300, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(() => document.getElementById("messages").scrollTop > 10000);

      // Reverse the same drag: a track click would page down but would not
      // follow the pointer back to the top.
      await page.mouse.move(x, 300);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(() => document.getElementById("messages").scrollTop < 1000);
    } else {
      // Firefox uses OS-controlled scrollbar geometry (possibly overlay),
      // but must keep the full native width and our theme-aware colors.
      assert.notEqual(await page.locator("#messages").evaluate((el) => getComputedStyle(el).scrollbarColor),
        "auto", `${name}: themed native scrollbar`);
    }

    await page.evaluate(() => { document.documentElement.className = "base24-softstack-light"; });
    if (initial.custom) {
      const light = await metrics();
      assert.notEqual(light.thumbColor, initial.thumbColor, `${name}: follows the light theme`);
      assert.notEqual(light.thumbColor, light.trackColor, `${name}: visible on light background`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390,
      `${name}: no horizontal page overflow on mobile`);

    // Chromium reserves the same space for short conversations, avoiding
    // rewrapping when content grows. Native overlay behavior varies by OS;
    // WebKit does not reserve a custom scrollbar gutter without overflow.
    const gutter = (await metrics()).gutter;
    await page.locator("#content").evaluate((el) => { el.style.height = "100px"; });
    if (name === "chromium") {
      assert.equal((await metrics()).gutter, gutter, `${name}: stable gutter for short transcripts`);
    }
    console.log(`${name}: ${initial.custom ? "20px scrollbar and thumb dragging" : "native scrollbar fallback"}, scoping, themes, and mobile layout passed`);
  } finally {
    await browser.close();
  }
}
