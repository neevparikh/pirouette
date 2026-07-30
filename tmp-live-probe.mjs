import { chromium } from "playwright";

const URL_ = "http://127.0.0.1:7777/";
const AGENT = process.env.AGENT ?? "91d4f772"; // this session's own agent (running)

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}]`, m.text().slice(0, 200));
});

// SAFETY: never let a real interrupt/mutation leave the page.
await page.addInitScript(() => {
  const realFetch = window.fetch.bind(window);
  window.__blocked = [];
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      window.__blocked.push(`${method} ${url}`);
      return Promise.resolve(new Response(JSON.stringify({ interrupted: true, cleared: {} }), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    }
    return realFetch(input, init);
  };
});

await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForSelector(`[data-agent-id^="${AGENT}"]`, { timeout: 15000 });
await page.click(`[data-agent-id^="${AGENT}"]`);
await page.waitForTimeout(1500);

const probe = async (label) =>
  console.log(label, await page.evaluate(() => {
    const q = (id) => document.getElementById(id);
    const hidden = (id) => q(id)?.classList.contains("hidden") ?? null;
    return {
      vim: q("vim-toggle-btn")?.textContent,
      vimLabel: q("vim-mode-label")?.textContent,
      interruptPillHidden: hidden("agent-interrupt-btn"),
      extUiHidden: hidden("extension-ui-modal") ?? hidden("ext-ui-modal"),
      projModalHidden: hidden("new-project-modal"),
      mentionHidden: hidden("mention-popup"),
      slashHidden: hidden("slash-popup"),
      sidebarDrawer: q("chat-sidebar")?.classList.contains("drawer-open"),
      actionsDrawer: q("header-actions")?.classList.contains("drawer-open"),
      modelPickerHidden: hidden("model-picker"),
      thinkingPickerHidden: hidden("thinking-picker"),
      themePickerHidden: hidden("theme-picker"),
      active: document.activeElement?.id || document.activeElement?.tagName,
      blocked: window.__blocked.slice(),
    };
  }));

await probe("after select:");
await page.focus("#message-input");
await page.keyboard.type("draft text");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
await probe("after escape:");

await browser.close();
