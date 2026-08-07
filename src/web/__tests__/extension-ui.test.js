// @vitest-environment jsdom
//
// Extension UI surfaces: toasts (`extension_ui_notify`), the header
// status strip (`extension_ui_status`) and pinned widgets
// (`extension_ui_widget`).
//
// Everything here drives `handleEnvelope()` with the exact envelope shape
// the server broadcasts (src/server/pirouette-ui-context.ts), so these are
// end-to-end for the client half: envelope in, DOM out.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ExtensionUISurface,
  TOAST_BASE_MS,
  normalizeNotifyType,
  splitMessage,
  toastDurationMs,
  todoProgress,
} from "../extension-ui.js";

/** Build the host elements the surface paints into, mirroring the
 *  `#extension-toasts` / `#extension-status` / `#extension-widgets` slots
 *  in index.html. */
function setup({ selected = "agent-1", ...opts } = {}) {
  document.body.innerHTML = `
    <div id="extension-toasts" class="hidden"></div>
    <div id="extension-status" class="hidden"></div>
    <div id="extension-widgets" class="hidden"></div>
    <div id="extension-widgets-below" class="hidden"></div>
  `;
  const surface = new ExtensionUISurface({
    toastHost: document.getElementById("extension-toasts"),
    statusHost: document.getElementById("extension-status"),
    widgetHost: document.getElementById("extension-widgets"),
    widgetHostBelow: document.getElementById("extension-widgets-below"),
    agentLabel: (id) => `chat-${id}`,
    ...opts,
  });
  surface.setSelectedAgent(selected);
  return surface;
}

const toasts = () => [...document.querySelectorAll("[data-toast-id]")];
const toastText = () => toasts().map((el) => el.textContent);
const statusPills = () => [...document.querySelectorAll("[data-status-key]")];

function notifyEnvelope(agentId, message, notifyType) {
  return { kind: "extension_ui_notify", agentId, message, notifyType };
}
function statusEnvelope(agentId, statusKey, statusText) {
  return { kind: "extension_ui_status", agentId, statusKey, statusText };
}
function widgetEnvelope(agentId, widgetKey, widget) {
  return { kind: "extension_ui_widget", agentId, widgetKey, widget };
}
/** A widget in the shape server/widget-render.ts produces. */
function widget(key, lines, placement = "aboveEditor") {
  return { key, placement, lines };
}
const widgetBlocks = (id = "extension-widgets") =>
  [...document.getElementById(id).querySelectorAll("[data-widget-key]")];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeNotifyType", () => {
  it("maps the known types", () => {
    expect(normalizeNotifyType("info")).toBe("info");
    expect(normalizeNotifyType("warn")).toBe("warn");
    expect(normalizeNotifyType("warning")).toBe("warn");
    expect(normalizeNotifyType("error")).toBe("error");
  });
  it("treats anything else as info", () => {
    expect(normalizeNotifyType(undefined)).toBe("info");
    expect(normalizeNotifyType(null)).toBe("info");
    expect(normalizeNotifyType("success")).toBe("info");
    expect(normalizeNotifyType(42)).toBe("info");
  });
  it("is case-insensitive", () => {
    expect(normalizeNotifyType("ERROR")).toBe("error");
  });
});

describe("splitMessage", () => {
  it("keeps a short single line inline", () => {
    const s = splitMessage("all good");
    expect(s.head).toBe("all good");
    expect(s.extraLines).toBe(0);
    expect(s.long).toBe(false);
  });
  it("counts the remaining lines of a multi-line payload", () => {
    const s = splitMessage("config:\n{\n  \"a\": 1\n}");
    expect(s.head).toBe("config:");
    expect(s.extraLines).toBe(3);
    expect(s.long).toBe(true);
  });
  it("skips leading blank lines", () => {
    expect(splitMessage("\n\nreal line").head).toBe("real line");
  });
  it("treats a very long single line as long", () => {
    expect(splitMessage("x".repeat(400)).long).toBe(true);
  });
});

describe("toastDurationMs", () => {
  it("scales with severity", () => {
    expect(toastDurationMs("error", "x")).toBeGreaterThan(toastDurationMs("info", "x"));
  });
  it("gives longer messages more time, within a cap", () => {
    const short = toastDurationMs("info", "x");
    const long = toastDurationMs("info", "x".repeat(10_000));
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThan(TOAST_BASE_MS.info + 10_000);
  });
});

describe("notify envelopes", () => {
  it("renders a toast for the selected agent", () => {
    const surface = setup();
    surface.handleEnvelope(notifyEnvelope("agent-1", "auto mode is on", "info"));
    expect(toasts()).toHaveLength(1);
    expect(toastText()[0]).toContain("auto mode is on");
    expect(document.getElementById("extension-toasts").classList.contains("hidden")).toBe(false);
  });

  it("styles by notify type and defaults to info", () => {
    const surface = setup();
    surface.handleEnvelope(notifyEnvelope("agent-1", "a", "error"));
    surface.handleEnvelope(notifyEnvelope("agent-1", "b"));
    const [first, second] = toasts();
    expect(first.dataset.toastType).toBe("error");
    expect(first.className).toContain("base16-red");
    expect(second.dataset.toastType).toBe("info");
    expect(second.className).toContain("base16-blue");
  });

  it("uses only base16 theme classes (no hardcoded colours)", () => {
    const surface = setup();
    surface.handleEnvelope(notifyEnvelope("agent-1", "hello", "warn"));
    const html = document.getElementById("extension-toasts").innerHTML;
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\b(?:rgb|hsl)a?\(/);
    expect(html).toContain("base16-yellow");
  });

  it("never interprets message content as HTML", () => {
    const surface = setup();
    surface.handleEnvelope(notifyEnvelope("agent-1", "<img src=x onerror=boom>", "info"));
    expect(document.querySelector("#extension-toasts img")).toBeNull();
    expect(toastText()[0]).toContain("<img src=x onerror=boom>");
  });

  it("auto-dismisses on a timer", () => {
    const surface = setup();
    surface.handleEnvelope(notifyEnvelope("agent-1", "transient", "info"));
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(toastDurationMs("info", "transient") + 1);
    expect(toasts()).toHaveLength(0);
    expect(document.getElementById("extension-toasts").classList.contains("hidden")).toBe(true);
  });

  it("dismisses on click of the close button", () => {
    const surface = setup();
    surface.handleEnvelope(notifyEnvelope("agent-1", "dismiss me", "info"));
    document.querySelector("[data-toast-close]").click();
    expect(toasts()).toHaveLength(0);
  });

  it("pauses the countdown while hovered", () => {
    const surface = setup();
    surface.handleEnvelope(notifyEnvelope("agent-1", "hover", "info"));
    const el = toasts()[0];
    el.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(TOAST_BASE_MS.info * 3);
    expect(toasts()).toHaveLength(1);
    el.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(TOAST_BASE_MS.info * 3);
    expect(toasts()).toHaveLength(0);
  });

  it("caps how many toasts stack, and releases queued ones as slots free", () => {
    const surface = setup({ maxVisible: 2 });
    for (const n of [1, 2, 3]) {
      surface.handleEnvelope(notifyEnvelope("agent-1", `msg ${n}`, "info"));
    }
    expect(toasts()).toHaveLength(2);
    expect(toastText().join(" ")).not.toContain("msg 3");
    document.querySelector("[data-toast-close]").click();
    expect(toasts()).toHaveLength(2);
    expect(toastText().join(" ")).toContain("msg 3");
  });

  it("drops the oldest queued entry past the queue limit", () => {
    const surface = setup({ maxVisible: 1, queueLimit: 2 });
    for (const n of [1, 2, 3, 4]) {
      surface.handleEnvelope(notifyEnvelope("agent-1", `msg ${n}`, "info"));
    }
    // 1 on screen, queue holds at most 2 -> the middle ones fell off.
    expect(toasts()).toHaveLength(1);
    expect(surface.pendingFor("agent-1").count).toBe(2);
  });
});

describe("long payloads", () => {
  const CONFIG = ["config:", "{", '  "model": "some-model",', '  "enabled": true', "}"].join("\n");

  it("collapses a multi-line payload to its first line plus a toggle", () => {
    const surface = setup();
    surface.handleEnvelope(notifyEnvelope("agent-1", CONFIG, "info"));
    const pre = document.querySelector("#extension-toasts pre");
    expect(pre.classList.contains("hidden")).toBe(true);
    const toggle = document.querySelector("[data-toast-expand]");
    expect(toggle.textContent).toContain("+4 lines");
  });

  it("expands to the full scrollable payload and pins the toast", () => {
    const surface = setup();
    surface.handleEnvelope(notifyEnvelope("agent-1", CONFIG, "info"));
    document.querySelector("[data-toast-expand]").click();
    const pre = document.querySelector("#extension-toasts pre");
    expect(pre.classList.contains("hidden")).toBe(false);
    expect(pre.textContent).toBe(CONFIG);
    expect(pre.className).toContain("overflow-auto");
    // Pinned: the auto-dismiss timer must not eat a payload mid-read.
    vi.advanceTimersByTime(10 * 60_000);
    expect(toasts()).toHaveLength(1);
    // Collapsing re-arms it.
    document.querySelector("[data-toast-expand]").click();
    vi.advanceTimersByTime(10 * 60_000);
    expect(toasts()).toHaveLength(0);
  });

  it("shows no expander for a short single-line message", () => {
    const surface = setup();
    surface.handleEnvelope(notifyEnvelope("agent-1", "short", "info"));
    expect(document.querySelector("[data-toast-expand]")).toBeNull();
  });
});

describe("per-agent routing", () => {
  it("does not show another agent's toast", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(notifyEnvelope("agent-2", "not yours", "info"));
    expect(toasts()).toHaveLength(0);
    expect(surface.pendingFor("agent-2")).toEqual({ count: 1, severity: "info" });
  });

  it("flushes the queue when that agent is selected", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(notifyEnvelope("agent-2", "queued", "warn"));
    surface.setSelectedAgent("agent-2");
    expect(toastText()[0]).toContain("queued");
    expect(surface.pendingFor("agent-2")).toBeNull();
  });

  it("parks visible toasts back on the queue when switching away", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(notifyEnvelope("agent-1", "mine", "info"));
    surface.setSelectedAgent("agent-2");
    expect(toasts()).toHaveLength(0);
    expect(surface.pendingFor("agent-1").count).toBe(1);
    surface.setSelectedAgent("agent-1");
    expect(toastText()[0]).toContain("mine");
  });

  it("drops stale queued notifications instead of showing them late", () => {
    let clock = 1_000;
    const surface = setup({ selected: "agent-1", now: () => clock, staleMs: 60_000 });
    surface.handleEnvelope(notifyEnvelope("agent-2", "ancient history", "info"));
    clock += 120_000;
    expect(surface.pendingFor("agent-2")).toBeNull();
    surface.setSelectedAgent("agent-2");
    expect(toasts()).toHaveLength(0);
  });

  it("reports the worst severity waiting for a background agent", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(notifyEnvelope("agent-2", "a", "info"));
    surface.handleEnvelope(notifyEnvelope("agent-2", "b", "error"));
    surface.handleEnvelope(notifyEnvelope("agent-2", "c", "warn"));
    expect(surface.pendingFor("agent-2")).toEqual({ count: 3, severity: "error" });
  });

  it("labels a toast with the agent it came from", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(notifyEnvelope("agent-1", "hi", "info"));
    expect(toastText()[0]).toContain("chat-agent-1");
  });

  it("fires onChatListChange so the chat list can repaint", () => {
    const surface = setup({ selected: "agent-1" });
    const spy = vi.fn();
    surface.onChatListChange = spy;
    surface.handleEnvelope(notifyEnvelope("agent-2", "ping", "info"));
    expect(spy).toHaveBeenCalled();
  });
});

describe("status envelopes", () => {
  it("renders a pill for the selected agent", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(statusEnvelope("agent-1", "auto-mode", "auto ✓ (classifier: some-model)"));
    const pills = statusPills();
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toBe("auto ✓ (classifier: some-model)");
    expect(pills[0].dataset.statusKey).toBe("auto-mode");
    expect(pills[0].title).toContain("auto-mode:");
    expect(document.getElementById("extension-status").classList.contains("hidden")).toBe(false);
  });

  it("replaces the text for a key rather than appending", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(statusEnvelope("agent-1", "auto-mode", "auto ✓"));
    surface.handleEnvelope(statusEnvelope("agent-1", "auto-mode", "auto ⚠ (classifier unavailable)"));
    expect(statusPills()).toHaveLength(1);
    expect(statusPills()[0].textContent).toBe("auto ⚠ (classifier unavailable)");
  });

  it("keeps several keys in a stable order", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(statusEnvelope("agent-1", "zeta", "z"));
    surface.handleEnvelope(statusEnvelope("agent-1", "alpha", "a"));
    expect(statusPills().map((p) => p.dataset.statusKey)).toEqual(["alpha", "zeta"]);
  });

  it("clears a key on null and hides the strip when empty", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(statusEnvelope("agent-1", "auto-mode", "auto ✓"));
    surface.handleEnvelope(statusEnvelope("agent-1", "auto-mode", null));
    expect(statusPills()).toHaveLength(0);
    expect(document.getElementById("extension-status").classList.contains("hidden")).toBe(true);
  });

  it("shows only the selected agent's status, and swaps on selection", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(statusEnvelope("agent-2", "auto-mode", "other agent"));
    expect(statusPills()).toHaveLength(0);
    surface.setSelectedAgent("agent-2");
    expect(statusPills().map((p) => p.textContent)).toEqual(["other agent"]);
    surface.setSelectedAgent("agent-1");
    expect(statusPills()).toHaveLength(0);
  });
});

describe("widget envelopes", () => {
  const todoWidget = widget("todo-list", [
    [
      { text: " Todo List ", color: "accent", bold: true },
      { text: "— 1/3 completed", color: "muted" },
    ],
    [
      { text: "  ✓ " },
      { text: "1.", color: "accent" },
      { text: " ship it", color: "dim", strikethrough: true },
    ],
  ]);

  it("paints a widget above the editor with themed spans", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(widgetEnvelope("agent-1", "todo-list", todoWidget));

    const blocks = widgetBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].dataset.widgetKey).toBe("todo-list");
    expect(blocks[0].textContent).toContain("Todo List");
    expect(blocks[0].textContent).toContain("ship it");
    const html = blocks[0].innerHTML;
    expect(html).toContain("text-base16-cyan"); // accent
    expect(html).toContain("font-bold");
    expect(html).toContain("line-through"); // completed item
    expect(document.getElementById("extension-widgets").classList.contains("hidden")).toBe(
      false,
    );
  });

  it("keeps one line per widget line", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(widgetEnvelope("agent-1", "todo-list", todoWidget));
    expect(widgetBlocks()[0].children).toHaveLength(2);
  });

  it("never renders extension text as HTML", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(
      widgetEnvelope("agent-1", "evil", widget("evil", [[{ text: "<img src=x onerror=1>" }]])),
    );
    expect(widgetBlocks()[0].querySelector("img")).toBeNull();
    expect(widgetBlocks()[0].textContent).toContain("<img src=x onerror=1>");
  });

  it("ignores colour names it doesn't know instead of inventing a class", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(
      widgetEnvelope("agent-1", "w", widget("w", [[{ text: "x", color: "nonsense" }]])),
    );
    expect(widgetBlocks()[0].innerHTML).not.toContain("nonsense");
    expect(widgetBlocks()[0].textContent).toBe("x");
  });

  it("keeps a blank line from collapsing", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(widgetEnvelope("agent-1", "w", widget("w", [[], [{ text: "x" }]])));
    expect(widgetBlocks()[0].children[0].textContent).toBe("\u00a0");
  });

  it("routes belowEditor widgets to the lower strip", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(
      widgetEnvelope("agent-1", "w", widget("w", [[{ text: "under" }]], "belowEditor")),
    );
    expect(widgetBlocks()).toHaveLength(0);
    expect(widgetBlocks("extension-widgets-below")).toHaveLength(1);
    expect(document.getElementById("extension-widgets").classList.contains("hidden")).toBe(true);
  });

  it("replaces a widget under the same key and orders keys stably", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(widgetEnvelope("agent-1", "zeta", widget("zeta", [[{ text: "z" }]])));
    surface.handleEnvelope(widgetEnvelope("agent-1", "alpha", widget("alpha", [[{ text: "a" }]])));
    surface.handleEnvelope(
      widgetEnvelope("agent-1", "zeta", widget("zeta", [[{ text: "z2" }]])),
    );
    expect(widgetBlocks().map((b) => b.dataset.widgetKey)).toEqual(["alpha", "zeta"]);
    expect(widgetBlocks()[1].textContent).toBe("z2");
  });

  it("clears a widget on null and hides the strip when empty", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(widgetEnvelope("agent-1", "todo-list", todoWidget));
    surface.handleEnvelope(widgetEnvelope("agent-1", "todo-list", null));
    expect(widgetBlocks()).toHaveLength(0);
    expect(document.getElementById("extension-widgets").classList.contains("hidden")).toBe(true);
  });

  it("shows only the selected agent's widgets, and swaps on selection", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(
      widgetEnvelope("agent-2", "todo-list", widget("todo-list", [[{ text: "other" }]])),
    );
    expect(widgetBlocks()).toHaveLength(0);
    surface.setSelectedAgent("agent-2");
    expect(widgetBlocks()[0].textContent).toBe("other");
    surface.setSelectedAgent("agent-1");
    expect(widgetBlocks()).toHaveLength(0);
  });
});

describe("todo progress", () => {
  /** The shape the todo extension's widget renders to. */
  const list = (items, header = null) =>
    widget("todo-list", [
      [{ text: header ?? ` Todo List — ${items.filter((i) => i === "✓").length}/${items.length} completed` }],
      ...items.map((glyph, i) => [{ text: `  ${glyph} ${i + 1}. item ${i + 1}` }]),
    ]);

  it("counts items by their status glyph", () => {
    expect(todoProgress(list(["✓", "✓", "◉", "○", "○"]))).toEqual({
      done: 2,
      active: 1,
      total: 5,
    });
  });

  it("recognises the common glyph variants", () => {
    expect(todoProgress(list(["✔", "☑", "●", "◯", "☐"]))).toEqual({
      done: 2,
      active: 1,
      total: 5,
    });
  });

  it("falls back to the header when a widget only prints a summary", () => {
    const summary = widget("todo-list", [[{ text: "todos: 3/8 completed" }]]);
    expect(todoProgress(summary)).toEqual({ done: 3, active: 0, total: 8 });
  });

  it("reads a todo widget that doesn't say 'todo' in its key", () => {
    const w = widget("tasks", [
      [{ text: "2/3 done" }],
      [{ text: "  ✓ a" }],
      [{ text: "  ✓ b" }],
      [{ text: "  ○ c" }],
    ]);
    expect(todoProgress(w)).toEqual({ done: 2, active: 0, total: 3 });
  });

  it("ignores a widget that is not a todo list at all", () => {
    const w = widget("weather", [[{ text: "● heavy rain" }], [{ text: "○ clearing later" }]]);
    expect(todoProgress(w)).toBeNull();
  });

  it("ignores junk", () => {
    expect(todoProgress(null)).toBeNull();
    expect(todoProgress({ key: "todo-list" })).toBeNull();
    expect(todoProgress(widget("todo-list", []))).toBeNull();
  });

  it("answers for any agent, not just the selected one", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(widgetEnvelope("agent-2", "todo-list", list(["✓", "◉", "○"])));
    expect(surface.todoProgressFor("agent-2")).toEqual({ done: 1, active: 1, total: 3 });
    expect(surface.todoProgressFor("agent-1")).toBeNull();
  });

  it("tracks updates and clearing", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(widgetEnvelope("agent-1", "todo-list", list(["✓", "○"])));
    expect(surface.todoProgressFor("agent-1")).toEqual({ done: 1, active: 0, total: 2 });
    surface.handleEnvelope(widgetEnvelope("agent-1", "todo-list", list(["✓", "✓"])));
    expect(surface.todoProgressFor("agent-1")).toEqual({ done: 2, active: 0, total: 2 });
    surface.handleEnvelope(widgetEnvelope("agent-1", "todo-list", null));
    expect(surface.todoProgressFor("agent-1")).toBeNull();
  });

  it("skips a non-todo widget to find the todo one", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(
      widgetEnvelope("agent-1", "aaa-weather", widget("aaa-weather", [[{ text: "● rain" }]])),
    );
    surface.handleEnvelope(widgetEnvelope("agent-1", "todo-list", list(["✓", "○", "○"])));
    expect(surface.todoProgressFor("agent-1")).toEqual({ done: 1, active: 0, total: 3 });
  });

  it("repaints the chat list when a widget changes", () => {
    const surface = setup({ selected: "agent-1" });
    const spy = vi.fn();
    surface.onChatListChange = spy;
    surface.handleEnvelope(widgetEnvelope("agent-2", "todo-list", list(["○"])));
    expect(spy).toHaveBeenCalled();
  });
});

describe("lifecycle", () => {
  it("forgetAgent drops toasts, queue and status for a removed agent", () => {
    const surface = setup({ selected: "agent-1" });
    surface.handleEnvelope(notifyEnvelope("agent-1", "on screen", "info"));
    surface.handleEnvelope(statusEnvelope("agent-1", "k", "v"));
    surface.handleEnvelope(
      widgetEnvelope("agent-1", "todo-list", widget("todo-list", [[{ text: "1/2" }]])),
    );
    surface.handleEnvelope(notifyEnvelope("agent-2", "queued", "info"));
    surface.forgetAgent("agent-1");
    surface.forgetAgent("agent-2");
    expect(toasts()).toHaveLength(0);
    expect(statusPills()).toHaveLength(0);
    expect(widgetBlocks()).toHaveLength(0);
    expect(surface.pendingFor("agent-2")).toBeNull();
  });

  it("ignores envelopes it doesn't own", () => {
    const surface = setup();
    expect(surface.handleEnvelope({ kind: "agents_list", agents: [] })).toBe(false);
    expect(surface.handleEnvelope(null)).toBe(false);
    expect(toasts()).toHaveLength(0);
  });

  it("holds notifications that arrive before any agent is selected", () => {
    const surface = setup({ selected: null });
    surface.handleEnvelope(notifyEnvelope("agent-1", "early", "info"));
    expect(toasts()).toHaveLength(0);
    surface.setSelectedAgent("agent-1");
    expect(toastText()[0]).toContain("early");
  });
});

describe("dashboard wiring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (name) => readFileSync(resolve(here, "..", name), "utf8");

  it("index.html declares every host slot", () => {
    const html = read("index.html");
    expect(html).toContain('id="extension-toasts"');
    expect(html).toContain('id="extension-status"');
    expect(html).toContain('id="extension-widgets"');
    expect(html).toContain('id="extension-widgets-below"');
  });

  it("app.js routes every envelope kind into the surface", () => {
    const app = read("app.js");
    expect(app).toMatch(
      /case "extension_ui_notify":\s*\n\s*case "extension_ui_status":\s*\n\s*case "extension_ui_widget":/,
    );
    expect(app).toContain("extensionUI.handleEnvelope(envelope)");
    // The old behaviour was a console.log and nothing else. Pin that it
    // stays gone, so the signal can't quietly go back to devtools-only.
    expect(app).not.toMatch(/console\.log\(\s*\n?\s*`\[extension:/);
  });

  it("app.js paints the todo count into the chat list", () => {
    const app = read("app.js");
    expect(app).toContain("extensionUI.todoProgressFor(a.id)");
    expect(app).toContain("data-todo-progress=");
    expect(app).toContain("extensionUI.onChatListChange = () => renderAgentList()");
  });

  it("app.js follows the chat selection and forgets removed agents", () => {
    const app = read("app.js");
    expect(app).toContain("extensionUI.setSelectedAgent(id)");
    expect(app).toContain("extensionUI.forgetAgent(envelope.agentId)");
  });
});
