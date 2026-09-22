import { describe, it, expect } from "vitest";
import {
  initialTranscriptState,
  messageKey,
  reduceEvent,
  reduceEvents,
  renderMessage,
  renderTranscript,
  renderTranscriptBlocks,
  STREAMING_TEXT_KEY,
  STREAMING_THINKING_KEY,
} from "../transcript.js";

// --- reducer tests ---

describe("reduceEvent", () => {
  it("starts fresh from initial state", () => {
    expect(initialTranscriptState()).toEqual({
      messages: [],
      streamingText: "",
      streamingThinking: "",
      queue: { steering: [], followUp: [] },
      compaction: { active: false, reason: null, lastResult: null },
    });
  });

  it("accumulates text deltas", () => {
    const s0 = initialTranscriptState();
    const s1 = reduceEvent(s0, { type: "message_start", role: "assistant" });
    const s2 = reduceEvent(s1, {
      type: "message_update",
      updateType: "text_delta",
      delta: "Hello ",
    });
    const s3 = reduceEvent(s2, {
      type: "message_update",
      updateType: "text_delta",
      delta: "world",
    });
    expect(s3.streamingText).toBe("Hello world");
    expect(s3.messages).toHaveLength(0);
  });

  it("accumulates thinking deltas separately from text", () => {
    const s0 = initialTranscriptState();
    const s1 = reduceEvents(
      [
        { type: "message_start", role: "assistant" },
        { type: "message_update", updateType: "thinking_delta", delta: "hmm " },
        { type: "message_update", updateType: "thinking_delta", delta: "ok" },
        { type: "message_update", updateType: "text_delta", delta: "Done." },
      ],
      s0,
    );
    expect(s1.streamingThinking).toBe("hmm ok");
    expect(s1.streamingText).toBe("Done.");
  });

  it("finalizes thinking + text on message_end in correct order", () => {
    const final = reduceEvents(
      [
        { type: "message_start", role: "assistant" },
        { type: "message_update", updateType: "thinking_delta", delta: "plan: X" },
        { type: "message_update", updateType: "text_delta", delta: "Answer." },
        { type: "message_end", role: "assistant" },
      ],
      initialTranscriptState(),
      1234,
    );
    expect(final.streamingText).toBe("");
    expect(final.streamingThinking).toBe("");
    expect(final.messages).toEqual([
      { role: "thinking", content: "plan: X", ts: 1234 },
      { role: "assistant", content: "Answer.", ts: 1234 },
    ]);
  });

  it("doesn't add empty thinking/text messages", () => {
    const final = reduceEvents(
      [
        { type: "message_start", role: "assistant" },
        { type: "message_update", updateType: "text_delta", delta: "hi" },
        { type: "message_end", role: "assistant" },
      ],
      initialTranscriptState(),
      1,
    );
    expect(final.messages).toEqual([{ role: "assistant", content: "hi", ts: 1 }]);
  });

  it("handles tool_execution_start then _end", () => {
    const final = reduceEvents(
      [
        {
          type: "tool_execution_start",
          toolName: "bash",
          toolCallId: "c1",
          args: { command: "ls" },
        },
        {
          type: "tool_execution_end",
          toolName: "bash",
          toolCallId: "c1",
          isError: false,
          result: { content: [{ type: "text", text: "foo\nbar" }] },
        },
      ],
      initialTranscriptState(),
      5,
    );
    expect(final.messages).toHaveLength(2);
    expect(final.messages[0]).toMatchObject({
      role: "tool",
      toolName: "bash",
      toolCallId: "c1",
      args: { command: "ls" },
    });
    expect(final.messages[1]).toMatchObject({
      role: "tool_result",
      toolName: "bash",
      toolCallId: "c1",
      content: "foo\nbar",
      isError: false,
    });
  });

  it("retains long tool output for expansion", () => {
    const huge = "x".repeat(3000);
    const s = reduceEvent(initialTranscriptState(), {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "c",
      isError: false,
      result: { content: [{ type: "text", text: huge }] },
    });
    expect(s.messages[0].content).toBe(huge);
  });

  it("marks errors on tool_execution_end", () => {
    const s = reduceEvent(initialTranscriptState(), {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "c",
      isError: true,
      result: { content: [{ type: "text", text: "oops" }] },
    });
    expect(s.messages[0].isError).toBe(true);
  });

  it("appends user messages streamed from the server", () => {
    // A message sent by anyone but this browser tab (`pru send`, another
    // agent, a second tab) only ever reaches the UI as an event.
    const s = reduceEvent(
      initialTranscriptState(),
      { type: "message_end", role: "user", text: "start on the refactor" },
      7,
    );
    expect(s.messages).toEqual([
      { role: "user", content: "start on the refactor", ts: 7 },
    ]);
  });

  it("carries image attachments on streamed user messages", () => {
    const images = [{ dataUrl: "data:image/png;base64,AAA", mimeType: "image/png" }];
    const s = reduceEvent(
      initialTranscriptState(),
      { type: "message_end", role: "user", text: "look", images },
      7,
    );
    expect(s.messages[0]).toEqual({ role: "user", content: "look", ts: 7, images });
  });

  it("ignores an empty user message rather than drawing a blank row", () => {
    const s0 = initialTranscriptState();
    const s1 = reduceEvent(s0, { type: "message_end", role: "user", text: "" }, 7);
    expect(s1.messages).toEqual([]);
  });

  it("confirms an optimistic pending message instead of duplicating it", () => {
    const s0 = {
      ...initialTranscriptState(),
      messages: [{ role: "user", content: "hi", ts: 1, pending: true }],
    };
    const s1 = reduceEvent(s0, { type: "message_end", role: "user", text: "hi" }, 7);
    expect(s1.messages).toEqual([{ role: "user", content: "hi", ts: 1 }]);
  });

  it("confirms one pending message per echo when the same text is sent twice", () => {
    const s0 = {
      ...initialTranscriptState(),
      messages: [
        { role: "user", content: "continue", ts: 1, pending: true },
        { role: "user", content: "continue", ts: 2, pending: true },
      ],
    };
    const s1 = reduceEvent(s0, { type: "message_end", role: "user", text: "continue" }, 7);
    expect(s1.messages.map((m) => m.pending)).toEqual([undefined, true]);
    const s2 = reduceEvent(s1, { type: "message_end", role: "user", text: "continue" }, 8);
    expect(s2.messages.map((m) => m.pending)).toEqual([undefined, undefined]);
    expect(s2.messages).toHaveLength(2);
  });

  it("appends a streamed user message that doesn't match any pending one", () => {
    const s0 = {
      ...initialTranscriptState(),
      messages: [{ role: "user", content: "mine", ts: 1, pending: true }],
    };
    const s1 = reduceEvent(s0, { type: "message_end", role: "user", text: "theirs" }, 7);
    expect(s1.messages).toEqual([
      { role: "user", content: "mine", ts: 1, pending: true },
      { role: "user", content: "theirs", ts: 7 },
    ]);
  });

  it("keeps in-flight assistant streaming intact around a user message", () => {
    // A steering message is consumed mid-turn: the partial assistant text
    // must survive so the live bubble doesn't blank out.
    const s0 = reduceEvents(
      [
        { type: "message_start", role: "assistant" },
        { type: "message_update", updateType: "text_delta", delta: "working" },
      ],
      initialTranscriptState(),
    );
    const s1 = reduceEvent(s0, { type: "message_end", role: "user", text: "stop" }, 7);
    expect(s1.streamingText).toBe("working");
    expect(s1.messages).toEqual([{ role: "user", content: "stop", ts: 7 }]);
  });

  it("is pure (doesn't mutate input state)", () => {
    const s0 = initialTranscriptState();
    const frozen = Object.freeze({ ...s0, messages: Object.freeze([...s0.messages]) });
    reduceEvent(frozen, { type: "message_start", role: "assistant" });
    // If it tried to mutate, the freeze would throw. Reaching here = ok.
    expect(frozen.messages).toHaveLength(0);
  });

  it("queue_update populates state.queue (mirroring pi's session queues)", () => {
    const s0 = initialTranscriptState();
    const s1 = reduceEvent(s0, {
      type: "queue_update",
      steering: ["wait, do X first"],
      followUp: ["and also Y", "and Z"],
    });
    expect(s1.queue).toEqual({
      steering: ["wait, do X first"],
      followUp: ["and also Y", "and Z"],
    });
    // Other state is untouched.
    expect(s1.messages).toEqual([]);
    expect(s1.streamingText).toBe("");
  });

  it("queue persists through unrelated events", () => {
    let s = reduceEvent(initialTranscriptState(), {
      type: "queue_update",
      steering: ["hold on"],
      followUp: [],
    });
    s = reduceEvent(s, { type: "message_start", role: "assistant" });
    s = reduceEvent(s, { type: "message_update", updateType: "text_delta", delta: "hi" });
    s = reduceEvent(s, { type: "message_end", role: "assistant" });
    expect(s.queue.steering).toEqual(["hold on"]);
  });

  it("compaction_start flips compaction.active and carries reason", () => {
    const s = reduceEvent(initialTranscriptState(), {
      type: "compaction_start",
      reason: "manual",
    });
    expect(s.compaction.active).toBe(true);
    expect(s.compaction.reason).toBe("manual");
    expect(s.compaction.lastResult).toBeNull();
  });

  it("compaction_end clears active and stores lastResult", () => {
    let s = reduceEvent(initialTranscriptState(), {
      type: "compaction_start",
      reason: "auto",
    });
    s = reduceEvent(s, {
      type: "compaction_end",
      reason: "auto",
      aborted: false,
      willRetry: false,
    });
    expect(s.compaction.active).toBe(false);
    expect(s.compaction.reason).toBeNull();
    expect(s.compaction.lastResult).toMatchObject({
      reason: "auto",
      aborted: false,
      willRetry: false,
    });
  });

  it("compaction events do not disturb other transcript state", () => {
    let s = reduceEvent(initialTranscriptState(), { type: "message_start", role: "assistant" });
    s = reduceEvent(s, { type: "message_update", updateType: "text_delta", delta: "hello" });
    s = reduceEvent(s, { type: "compaction_start", reason: "manual" });
    expect(s.streamingText).toBe("hello");
    expect(s.compaction.active).toBe(true);
    s = reduceEvent(s, { type: "compaction_end", reason: "manual", aborted: false, willRetry: false });
    expect(s.streamingText).toBe("hello");
    expect(s.compaction.active).toBe(false);
  });
});

describe("compaction outcomes", () => {
  function finish(event) {
    return reduceEvent(initialTranscriptState(), {
      type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, ...event,
    }, 1234);
  }

  it.each(["manual", "threshold", "overflow"])("shows %s errors, not success", (reason) => {
    const errorMessage = "Summarization failed: generation hit the token cap and the summary is incomplete";
    const state = finish({ reason, errorMessage });
    expect(state.compaction.lastResult).toMatchObject({ errorMessage, result: null });
    const html = renderTranscript(state, new Set());
    expect(html).toContain('role="alert"');
    expect(html).toContain("compaction failed");
    expect(html).toContain(errorMessage);
    expect(html).not.toContain("context compacted");
    expect(html).not.toContain("text-base16-green");
  });

  it("escapes provider error text instead of treating it as HTML or Markdown", () => {
    const html = renderTranscript(finish({ errorMessage: '<img src=x onerror="alert(1)"> **error** & failure' }), new Set());
    expect(html).toContain("&lt;img");
    expect(html).toContain("&amp; failure");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<strong>");
  });

  it("requires a result before claiming success", () => {
    const html = renderTranscript(finish({}), new Set());
    expect(html).toContain("compaction ended without a result");
    expect(html).not.toContain("context compacted");
  });

  it("shows success with before/after accounting", () => {
    const result = { tokensBefore: 120000, estimatedTokensAfter: 23000 };
    const state = finish({ result });
    expect(state.compaction.lastResult.result).toEqual(result);
    const html = renderTranscript(state, new Set());
    expect(html).toContain("context compacted (automatic threshold)");
    expect(html).toContain("120,000 → ~23,000 tokens");
    expect(html).not.toContain("compaction failed");
  });

  it("doesn't render invalid token accounting", () => {
    const html = renderTranscript(finish({ result: { tokensBefore: -1, estimatedTokensAfter: NaN } }), new Set());
    expect(html).toContain("context compacted");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("tokens");
  });

  it("shows cancellation separately from failure or success", () => {
    const html = renderTranscript(finish({ aborted: true, reason: "manual" }), new Set());
    expect(html).toContain("compaction aborted (manual)");
    expect(html).not.toContain("context compacted");
    expect(html).not.toContain("compaction failed");
  });

  it("prioritizes an error over result metadata", () => {
    const html = renderTranscript(finish({ errorMessage: "failure", result: { tokensBefore: 1 } }), new Set());
    expect(html).toContain("compaction failed");
    expect(html).not.toContain("context compacted");
  });

  it.each([
    { type: "message_start", role: "assistant" },
    { type: "message_update", updateType: "text_delta", delta: "working" },
    { type: "message_end", role: "assistant" },
    { type: "tool_execution_start", toolName: "read", toolCallId: "one", args: {} },
    { type: "tool_execution_end", toolName: "read", toolCallId: "one", result: { content: [] } },
    { type: "queue_update", steering: [], followUp: [] },
    { type: "agent_end" },
  ])("keeps failure status through $type", (event) => {
    const state = reduceEvent(finish({ errorMessage: "summary failed" }), event);
    expect(renderTranscript(state, new Set())).toContain("summary failed");
  });

  it("keeps an error through unrelated events and replaces it after successful recovery", () => {
    let state = finish({ errorMessage: "summary failed" });
    state = reduceEvent(state, { type: "agent_end" });
    expect(renderTranscript(state, new Set())).toContain("summary failed");
    state = reduceEvent(state, { type: "compaction_start", reason: "overflow" });
    expect(renderTranscript(state, new Set())).toContain("compacting context… (context recovery)");
    state = reduceEvent(state, {
      type: "compaction_end", reason: "overflow", aborted: false, willRetry: true,
      result: { tokensBefore: 120000, estimatedTokensAfter: 23000 },
    });
    const html = renderTranscript(state, new Set());
    expect(html).toContain("context compacted (context recovery)");
    expect(html).not.toContain("summary failed");
  });
});

// --- full mock transcript ---

/** A realistic transcript: user message → assistant thinks → uses bash → replies. */
const BASH_TRANSCRIPT_EVENTS = [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", role: "assistant" },
  { type: "message_update", updateType: "thinking_delta", delta: "Need to list files..." },
  {
    type: "message_update",
    updateType: "toolcall_end",
    toolName: "bash",
    toolCallId: "call_1",
  },
  { type: "message_end", role: "assistant" },
  {
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "call_1",
    args: { command: "ls -la", description: "list files" },
  },
  {
    type: "tool_execution_end",
    toolName: "bash",
    toolCallId: "call_1",
    isError: false,
    result: { content: [{ type: "text", text: "total 8\nfile.txt" }] },
  },
  { type: "turn_end" },
  { type: "turn_start" },
  { type: "message_start", role: "assistant" },
  { type: "message_update", updateType: "text_delta", delta: "Found " },
  { type: "message_update", updateType: "text_delta", delta: "**1 file**." },
  { type: "message_end", role: "assistant" },
  { type: "turn_end" },
  { type: "agent_end" },
];

describe("mock transcript", () => {
  it("produces the expected timeline", () => {
    const state = reduceEvents(BASH_TRANSCRIPT_EVENTS, initialTranscriptState(), 100);

    // Order: thinking → tool → tool_result → assistant
    expect(state.messages.map((m) => m.role)).toEqual([
      "thinking",
      "tool",
      "tool_result",
      "assistant",
    ]);
    expect(state.streamingText).toBe("");
    expect(state.streamingThinking).toBe("");
  });

  it("renders the timeline without throwing", () => {
    const state = reduceEvents(BASH_TRANSCRIPT_EVENTS, initialTranscriptState(), 100);
    const html = renderTranscript(state);
    expect(html).toContain("thinking");
    expect(html).toContain("bash");
    expect(html).toContain("list files");
    // Assistant markdown renders bold
    expect(html).toMatch(/<strong>1 file<\/strong>/);
  });
});

// --- renderMessage HTML snapshots (shape-only) ---

describe("renderMessage", () => {
  it("user message with image attachments renders an inline <img>", () => {
    const html = renderMessage(
      {
        role: "user",
        content: "look",
        ts: 0,
        images: [{ dataUrl: "data:image/png;base64,iVBOR", mimeType: "image/png" }],
      },
      0,
    );
    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/png;base64,iVBOR"');
    // Text bubble still renders alongside.
    expect(html).toContain("look");
  });

  it("user message with image but no text renders only the image", () => {
    const html = renderMessage(
      {
        role: "user",
        content: "",
        ts: 0,
        images: [{ dataUrl: "data:image/png;base64,iVBOR", mimeType: "image/png" }],
      },
      0,
    );
    expect(html).toContain("<img");
    // No text bubble div.
    expect(html).not.toContain("bg-base16-blue/15");
  });

  it("todo tool_result drops the boilerplate body but keeps the progress", () => {
    const html = renderMessage(
      {
        role: "tool_result",
        toolName: "manage_todo_list",
        content:
          "Todos have been modified successfully. 1/3 completed. Ensure that you continue to use the todo list to track your progress.",
        ts: 0,
      },
      0,
    );
    expect(html).toContain("1/3 completed");
    expect(html).not.toContain("Ensure that you continue");
  });

  it("a failed todo tool_result still shows its body", () => {
    const html = renderMessage(
      {
        role: "tool_result",
        toolName: "manage_todo_list",
        content: "Validation failed: id must be a number",
        isError: true,
        ts: 0,
      },
      0,
    );
    expect(html).toContain("Validation failed");
  });

  it("tool_result with images renders them under the expand chevron", () => {
    const html = renderMessage(
      {
        role: "tool_result",
        toolName: "screenshot",
        content: "",
        ts: 0,
        images: [{ dataUrl: "data:image/png;base64,XYZ", mimeType: "image/png" }],
      },
      0,
      new Set(["tool_result-0"]),
    );
    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/png;base64,XYZ"');
  });

  it("user message renders as a flat pi-cli row with escaped content", () => {
    // v0.12.0: flat layout. User messages are inline rows (no
    // right-aligned bubble), distinguished by a subtle bg tint via
    // the `pi-row-user` class.
    const html = renderMessage(
      { role: "user", content: "<script>x</script>", ts: 0 },
      0,
    );
    expect(html).toContain("pi-row-user");
    expect(html).toContain("&lt;script&gt;");
    // Old right-aligned alignment should no longer appear.
    expect(html).not.toContain("items-end");
    expect(html).not.toContain("justify-end");
  });

  it("assistant message renders markdown in a flat pi-cli row", () => {
    const html = renderMessage(
      { role: "assistant", content: "**bold**", ts: 0 },
      0,
    );
    expect(html).toContain("pi-row-assistant");
    // No widthCols supplied -> falls back to the legacy renderMarkdown
    // path which still emits a <strong> tag inside .md.
    expect(html).toMatch(/<strong>bold<\/strong>/);
    // Old left-aligned bubble classes should not appear.
    expect(html).not.toContain("justify-start");
  });

  it("streaming assistant has the streaming-body id and cursor", () => {
    const html = renderMessage(
      { role: "assistant", content: "partial", ts: 0, streaming: true },
      0,
    );
    expect(html).toContain('id="streaming-body"');
    expect(html).toContain("▊");
  });

  it("streaming assistant renders markdown as it streams when widthCols is set", () => {
    const html = renderMessage(
      { role: "assistant", content: "# Heading\n\nsome **bold** text", ts: 0, streaming: true },
      0,
      undefined,
      { widthCols: 80 },
    );
    // Uses the pi-tui markdown renderer (pi-md), not raw escaped text.
    expect(html).toContain('id="streaming-body"');
    expect(html).toContain('class="pi-md"');
    expect(html).toContain("pi-heading");
    expect(html).toContain("pi-strong");
    // Still carries the blinking cursor.
    expect(html).toContain("▊");
  });

  it("streaming assistant falls back to escaped text without widthCols", () => {
    const html = renderMessage(
      { role: "assistant", content: "<script>x</script>", ts: 0, streaming: true },
      0,
    );
    expect(html).toContain('id="streaming-body"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('class="pi-md"');
  });

  it("tool call uses smart header from describeToolCall", () => {
    const html = renderMessage(
      {
        role: "tool",
        content: "",
        toolName: "bash",
        toolCallId: "c",
        args: { command: "ls", description: "list" },
        ts: 0,
      },
      0,
    );
    expect(html).toContain("list");
    expect(html).toContain("ls");
  });

  it("tool result uses summary label", () => {
    // v0.13.5: success icon (✓/✗) dropped per user request. Tool
    // name still in cyan for success; red for errors. Summary in
    // muted text.
    const html = renderMessage(
      {
        role: "tool_result",
        toolName: "read",
        content: "a\nb\nc",
        isError: false,
        ts: 0,
      },
      0,
    );
    expect(html).not.toContain("✓");
    expect(html).toMatch(/<span[^>]*class="text-base16-cyan[^"]*"[^>]*>read<\/span>/);
    expect(html).toContain("3 lines");
  });

  it("tool result error renders tool name in red instead of cyan", () => {
    const html = renderMessage(
      {
        role: "tool_result",
        toolName: "bash",
        content: "fail",
        isError: true,
        ts: 0,
      },
      0,
    );
    // No icon glyph
    expect(html).not.toContain("✗");
    expect(html).not.toContain("✓");
    // Tool name renders in red (error signal moved from icon to name)
    expect(html).toMatch(/<span[^>]*class="text-base16-red[^"]*"[^>]*>bash<\/span>/);
    expect(html).not.toMatch(/<span[^>]*class="text-base16-cyan[^"]*"[^>]*>bash<\/span>/);
  });

  it("thinking renders collapsed by default", () => {
    const longThinking = "a".repeat(200);
    const html = renderMessage(
      { role: "thinking", content: longThinking, ts: 0 },
      0,
    );
    expect(html).toContain("thinking");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="message-preview-body is-collapsed"');
  });

  it("thinking expands when key is in expandedItems", () => {
    const longThinking = "a".repeat(200);
    const msg = { role: "thinking", content: longThinking, ts: 0 };
    const expanded = new Set([messageKey(msg, 0)]);
    const collapsedHtml = renderMessage(msg, 0, new Set());
    const expandedHtml = renderMessage(msg, 0, expanded);
    expect(collapsedHtml).toContain('class="message-preview-body is-collapsed"');
    expect(expandedHtml).not.toContain("is-collapsed");
    expect(expandedHtml).toContain('aria-expanded="true"');
    expect(expandedHtml).toContain("Show less");
    expect(collapsedHtml).toContain("Show all");
  });

  it("system message renders in orange warning style", () => {
    const html = renderMessage(
      { role: "system", content: "something broke", ts: 0 },
      0,
    );
    expect(html).toContain("base16-orange");
    expect(html).toContain("something broke");
  });

  it("unknown role returns empty string", () => {
    expect(renderMessage({ role: "nonsense", content: "x", ts: 0 }, 0)).toBe("");
  });
});

// --- block reconciliation contract --------------------------------
//
// app.js's reconciler relies on stable `data-msg-key` attributes and the
// per-block split returned by `renderTranscriptBlocks` to avoid rebuilding
// the whole transcript on every event. These tests lock in those contracts.

describe("renderTranscriptBlocks", () => {
  it("emits one block per finalized message with stable keys", () => {
    const state = {
      messages: [
        { role: "user", content: "hi", ts: 1 },
        { role: "assistant", content: "hello", ts: 2 },
        { role: "user", content: "again", ts: 3 },
      ],
      streamingText: "",
      streamingThinking: "",
    };
    const blocks = renderTranscriptBlocks(state);
    expect(blocks.map((b) => b.key)).toEqual(["msg:0", "msg:1", "msg:2"]);
    // Each block's html starts with the wrapper element carrying the same key.
    for (const b of blocks) {
      expect(b.html).toContain(`data-msg-key="${b.key}"`);
    }
  });

  it("emits each tool/tool_result as its own row (no grouping widget)", () => {
    // v0.12.6: pi-cli does not group consecutive tool calls. We
    // dropped the `run:<i>:<j>` collapsible-widget block and now
    // always emit per-message rows, whether the run is completed
    // (followed by an assistant message) or still in flight.
    const state = {
      messages: [
        { role: "tool", toolName: "read", args: {}, toolCallId: "c1", ts: 1 },
        { role: "tool_result", toolName: "read", content: "ok", toolCallId: "c1", ts: 2 },
        { role: "assistant", content: "done", ts: 3 },
      ],
      streamingText: "",
      streamingThinking: "",
    };
    const blocks = renderTranscriptBlocks(state);
    expect(blocks.map((b) => b.key)).toEqual([
      "tc:c1:tool",
      "tc:c1:tool_result",
      "msg:2",
    ]);
  });

  it("emits live tool rows individually when there's no follow-up", () => {
    const state = {
      messages: [
        { role: "tool", toolName: "read", args: {}, toolCallId: "c1", ts: 1 },
        { role: "tool_result", toolName: "read", content: "ok", toolCallId: "c1", ts: 2 },
      ],
      streamingText: "",
      streamingThinking: "",
    };
    const blocks = renderTranscriptBlocks(state);
    expect(blocks.map((b) => b.key)).toEqual([
      "tc:c1:tool",
      "tc:c1:tool_result",
    ]);
  });

  it("adds streaming bubbles with stable sentinel keys", () => {
    const state = {
      messages: [{ role: "user", content: "hi", ts: 1 }],
      streamingText: "reply...",
      streamingThinking: "hmm",
    };
    const blocks = renderTranscriptBlocks(state);
    const keys = blocks.map((b) => b.key);
    // Order: finalized messages, then thinking, then text.
    expect(keys).toEqual(["msg:0", STREAMING_THINKING_KEY, STREAMING_TEXT_KEY]);
  });

  it("is consistent with the string form of renderTranscript", () => {
    const state = {
      messages: [
        { role: "user", content: "a", ts: 1 },
        { role: "assistant", content: "b", ts: 2 },
      ],
      streamingText: "",
      streamingThinking: "",
    };
    const joined = renderTranscriptBlocks(state).map((b) => b.html).join("");
    expect(joined).toBe(renderTranscript(state));
  });
});
