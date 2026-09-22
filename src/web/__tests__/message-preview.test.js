// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMessage } from "../transcript.js";
import { syncMessagePreviews } from "../message-preview.js";

const render = (msg, expanded = new Set(), opts) => {
  const root = document.createElement("div");
  root.innerHTML = renderMessage({ ts: 0, ...msg }, 0, expanded, opts);
  return root;
};
const longText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");

describe("user and thinking previews", () => {
  it.each(["user", "thinking"])("folds %s messages without discarding content", (role) => {
    const root = render({ role, content: longText });
    expect(root.querySelector(".message-preview-body").classList.contains("is-collapsed")).toBe(true);
    expect(root.textContent).toContain("line 19");
    expect(root.querySelector("button").getAttribute("aria-expanded")).toBe("false");
    const full = render({ role, content: longText }, new Set(["msg:0"]));
    expect(full.querySelector(".is-collapsed")).toBeNull();
    expect(full.querySelector("button").textContent).toContain("Show less");
  });

  it("offers expansion based on visual overflow, including a single wrapped paragraph", () => {
    const root = render({ role: "user", content: "a long paragraph ".repeat(100) });
    const body = root.querySelector(".message-preview-body");
    const button = root.querySelector("button");
    Object.defineProperties(body, { scrollHeight: { configurable: true, value: 400 }, clientHeight: { value: 160 } });
    syncMessagePreviews(root);
    expect(button.hidden).toBe(false);
    Object.defineProperty(body, "scrollHeight", { value: 160 });
    syncMessagePreviews(root);
    expect(button.hidden).toBe(true);
  });

  it("keeps the collapse button available on expanded messages", () => {
    const root = render({ role: "user", content: longText }, new Set(["msg:0"]));
    syncMessagePreviews(root);
    expect(root.querySelector("button").hidden).toBe(false);
  });

  it.each([false, true])("renders Markdown in thinking (streaming=%s)", (streaming) => {
    const root = render({ role: "thinking", content: "**plan**\n\n- first\n- second\n\n`code`", streaming });
    const panel = root.querySelector(".pi-row-thinking");
    expect(panel.querySelector(".thinking-label").textContent).toBe(streaming ? "thinking…" : "thinking");
    expect(panel.querySelector(".message-preview")).not.toBeNull();
    expect(root.querySelector("strong").textContent).toBe("plan");
    expect(root.querySelectorAll("li")).toHaveLength(2);
    expect(root.querySelector("code").textContent).toBe("code");
    if (streaming) {
      expect(root.querySelector("#streaming-thinking-body")).not.toBeNull();
      expect(root.querySelector(".streaming-cursor")).not.toBeNull();
      expect(root.querySelector("button").getAttribute("data-toggle")).toBe("streaming-thinking");
    }
  });

  it("gives thinking a theme-aware box without styling assistant output", () => {
    const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../index.html"), "utf8");
    const rule = html.match(/\.pi-row-thinking\s*\{([^}]+)\}/)?.[1];
    expect(rule).toContain("background: rgb(var(--color-base16-purple)");
    expect(rule).toContain("border-radius:");
    expect(rule).toContain("box-shadow: inset");
    const assistant = render({ role: "assistant", content: "**answer**" });
    expect(assistant.querySelector(".pi-row-thinking, .thinking-label")).toBeNull();
  });

  it("uses terminal Markdown at measured widths and escapes untrusted thinking HTML", () => {
    const root = render({ role: "thinking", content: '**plan**\n\n<img src=x onerror="alert(1)">' }, new Set(), { widthCols: 80 });
    expect(root.querySelector(".pi-strong").textContent).toBe("plan");
    expect(root.querySelector("img, [onerror]")).toBeNull();
  });

  it("leaves user image attachments outside the folded text", () => {
    const root = render({ role: "user", content: longText, images: [{ dataUrl: "data:image/png;base64,AQID", mimeType: "image/png" }] });
    expect(root.querySelector("img").closest(".message-preview")).toBeNull();
  });
});
