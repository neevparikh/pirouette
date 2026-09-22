import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import hljs from "highlight.js/lib/common";
import { highlightToolCode, toolLanguageFromPath, toolResultLanguage } from "../tool-content.js";
import { initialTranscriptState, reduceEvent, renderMessage, renderTranscriptBlocks } from "../transcript.js";

const dom = (html) => JSDOM.fragment(html);
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const call = (args = {}, extra = {}) => ({ role: "tool", toolName: "write", toolCallId: "c1", args, ts: 1, ...extra });
const result = (content, extra = {}) => ({ role: "tool_result", toolName: "read", toolCallId: "c1", content, ts: 2, ...extra });

beforeEach(() => vi.stubGlobal("hljs", hljs));
afterEach(() => vi.unstubAllGlobals());

describe("compact tool content", () => {
  it.each([0, 1, 8])("does not fold %i lines of output", (n) => {
    const root = dom(renderMessage(result(lines(n)), 0));
    expect(root.querySelector("button")).toBeNull();
    if (n) expect(root.querySelector("code").textContent).toBe(lines(n));
  });

  it.each(["tool", "tool_result"])("previews and expands all %s content", (role) => {
    const text = lines(200);
    const msg = role === "tool" ? call({ path: "file.txt", content: text }) : result(text);
    const key = `tc:c1:${role}`;
    const collapsed = dom(renderMessage(msg, 0));
    expect(collapsed.querySelector("code").textContent).toBe(lines(8));
    const button = collapsed.querySelector("button");
    expect(button.textContent).toContain("Show all 200 lines");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(collapsed.getElementById(button.getAttribute("aria-controls"))).not.toBeNull();
    const expanded = dom(renderMessage(msg, 0, new Set([key])));
    expect(expanded.querySelector("code").textContent).toBe(text);
    expect(expanded.querySelector("button").textContent).toContain("Show less");
    expect(expanded.querySelector("button").getAttribute("aria-expanded")).toBe("true");
  });

  it("folds rich diffs without losing batch replacements", () => {
    const msg = call({ path: "file.txt", edits: [{ oldText: lines(7), newText: lines(5) }, { oldText: "last old", newText: "last new" }] }, { toolName: "edit" });
    const root = dom(renderMessage(msg, 0));
    expect(root.querySelectorAll(".diff-line")).toHaveLength(8);
    expect(root.querySelector("button").textContent).toContain("14 lines");
    const full = dom(renderMessage(msg, 0, new Set(["tc:c1:tool"])));
    expect(full.querySelectorAll(".diff-line")).toHaveLength(14);
    expect(full.textContent).toContain("last new");
  });

  it("folds long checklists", () => {
    const msg = call({ todoList: Array.from({ length: 12 }, (_, id) => ({ id, title: `todo-${id}` })) }, { toolName: "manage_todo_list" });
    expect(dom(renderMessage(msg, 0)).textContent).not.toContain("todo-8");
    expect(dom(renderMessage(msg, 0, new Set(["tc:c1:tool"]))).textContent).toContain("todo-11");
  });

  it("keeps input and output expansion independent", () => {
    const state = { ...initialTranscriptState(), messages: [call({ content: lines(12) }), result(lines(12))] };
    const blocks = renderTranscriptBlocks(state, new Set(["tc:c1:tool"]));
    expect(dom(blocks[0].html).querySelector("code").textContent).toBe(lines(12));
    expect(dom(blocks[1].html).querySelector("code").textContent).toBe(lines(8));
  });
});

describe("tool highlighting", () => {
  it("highlights short commands as well as multiline shell input", () => {
    const root = dom(renderMessage(call({ command: 'echo "$HOME"' }, { toolName: "bash" }), 0));
    expect(root.querySelector("code.language-bash .hljs-string")).not.toBeNull();
    expect(root.querySelector("code").textContent).toBe('echo "$HOME"');
  });

  it("highlights generic JSON arguments and structured results", () => {
    for (const msg of [call({ answer: 42 }, { toolName: "custom" }), result('{"answer":42}', { toolName: "custom" })]) {
      const root = dom(renderMessage(msg, 0));
      expect(root.querySelector("code.language-json .hljs-attr")).not.toBeNull();
    }
  });

  it("highlights file writes and matches read results to their input path", () => {
    const source = 'const answer = "yes";';
    const write = dom(renderMessage(call({ path: "file.ts", content: source }), 0));
    expect(write.querySelector(".hljs-keyword")).not.toBeNull();
    const state = { ...initialTranscriptState(), messages: [
      call({ path: "file.ts" }, { toolName: "read" }), result(source),
    ] };
    const read = dom(renderTranscriptBlocks(state)[1].html);
    expect(read.querySelector(".language-typescript .hljs-keyword")).not.toBeNull();
    expect(read.querySelector("code").textContent).toBe(source);
  });

  it("does not guess a language for logs, unknown extensions, or errors", () => {
    expect(toolLanguageFromPath("file.unknown")).toBe("");
    expect(toolResultLanguage("bash", {}, "const appears in a log", false)).toBe("");
    expect(toolResultLanguage("read", { path: "file.ts" }, "error", true)).toBe("");
    expect(toolResultLanguage("custom", {}, "{not JSON}", false)).toBe("");
    expect(toolLanguageFromPath("Dockerfile")).toBe("dockerfile");
  });

  it("escapes source HTML, paths, and call IDs in both preview and expanded content", () => {
    const source = '<img src=x onerror="alert(1)">';
    const id = 'x" onclick="alert(1)';
    const msg = call({ path: source + ".html", content: lines(8) + "\n" + source }, { toolCallId: id });
    const root = dom(renderMessage(msg, 0, new Set([`tc:${id}:tool`])));
    expect(root.querySelector("img, [onclick], [onerror]")).toBeNull();
    expect(root.querySelector("code").textContent).toContain(source);
    expect(root.querySelector("button").getAttribute("data-toggle")).toBe(`tc:${id}:tool`);
  });

  it("falls back safely without a highlighter or known grammar", () => {
    expect(highlightToolCode("<test>", "missing-grammar")).toBe("&lt;test&gt;");
    vi.stubGlobal("hljs", undefined);
    expect(highlightToolCode("<test>", "xml")).toBe("&lt;test&gt;");
    vi.stubGlobal("hljs", { getLanguage: () => true, highlight: () => { throw new Error("broken"); } });
    expect(highlightToolCode("<test>", "xml")).toBe("&lt;test&gt;");
  });

  it("does not run highlighting on huge expanded content", () => {
    const highlight = vi.fn();
    vi.stubGlobal("hljs", { getLanguage: () => true, highlight });
    const text = "<".repeat(100_001);
    expect(highlightToolCode(text, "xml")).toBe("&lt;".repeat(100_001));
    expect(highlight).not.toHaveBeenCalled();
  });
});

describe("tool lifecycle labels", () => {
  it("transitions Running to Completed on both matching rows", () => {
    const initial = initialTranscriptState();
    const started = reduceEvent(initial, { type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "pwd" } });
    expect(renderTranscriptBlocks(started)[0].html).toContain("tool-status-running");
    expect(initial.messages).toHaveLength(0);
    const ended = reduceEvent(started, { type: "tool_execution_end", toolName: "bash", toolCallId: "c1", result: { content: [] } });
    for (const block of renderTranscriptBlocks(ended)) {
      expect(block.html).toContain("tool-status-completed");
      expect(block.html).not.toContain("tool-spinner");
    }
    expect(started.messages[0].toolStatus).toBe("running");
  });

  it("matches parallel history results by ID, including failure and missing results", () => {
    const state = { ...initialTranscriptState(), messages: [
      call({}, { toolCallId: "a" }), call({}, { toolCallId: "b" }), call({}, { toolCallId: "c" }),
      result("failed", { toolCallId: "b", isError: true }), result("ok", { toolCallId: "a" }),
    ] };
    const blocks = renderTranscriptBlocks(state);
    expect(blocks[0].html).toContain("tool-status-completed");
    expect(blocks[1].html).toContain("tool-status-failed");
    expect(blocks[2].html).toContain("No result");
    expect(blocks[3].html).toContain("Failed");
  });

  it("does not leave an orphaned call running after the turn or session stops", () => {
    const state = reduceEvent(initialTranscriptState(), { type: "tool_execution_start", toolName: "bash", toolCallId: "c1" });
    expect(renderTranscriptBlocks(reduceEvent(state, { type: "agent_end" }))[0].html).toContain("No result");
    expect(renderTranscriptBlocks(state, undefined, { agentRunning: false })[0].html).toContain("No result");
  });
});
