// Transcript rendering and event-reduction logic.
// Pure ES module — no DOM access. Import from both browser (app.js) and tests.

import {
  describeToolCall,
  describeToolResult,
  escHtml,
  hidesToolResultBody,
  parseToolArgs,
  relTime,
  shortenPath,
} from "./render.js";
import { renderMessageMarkdown } from "./message-markdown.js";
import { renderMessagePreview } from "./message-preview.js";
import { isRasterDataUrl } from "./content-policy.js";
import { renderToolBody, toolLanguageFromPath, toolResultLanguage } from "./tool-content.js";

/**
 * @typedef {Object} ChatMessage
 * @property {"user"|"assistant"|"thinking"|"tool"|"tool_result"|"system"} role
 * @property {string} content
 * @property {number} ts
 * @property {string} [toolName]
 * @property {string} [toolCallId]
 * @property {Record<string, unknown>} [args]
 * @property {boolean} [isError]
 * @property {boolean} [streaming]
 * @property {"running"|"completed"|"failed"|"unknown"} [toolStatus]
 */

/**
 * @typedef {Object} TranscriptState
 * @property {ChatMessage[]} messages     Finalized messages (user / tool / assistant).
 * @property {string} streamingText       In-flight assistant text (if any).
 * @property {string} streamingThinking   In-flight assistant thinking (if any).
 * @property {{ steering: string[], followUp: string[] }} queue
 *           Pending steering / follow-up messages (mirror of pi's session
 *           queues). Populated by `queue_update` events.
 */

/** Initial empty state for a transcript reducer. */
export function initialTranscriptState() {
  return {
    messages: [],
    streamingText: "",
    streamingThinking: "",
    queue: { steering: [], followUp: [] },
    /** Compaction status. `active` toggles on compaction_start / -_end so
     *  the UI can render a "compacting…" indicator while it runs. After
     *  it ends, `lastResult` lingers until the next compaction so users
     *  can see what happened (briefly mirrored as a system-style block). */
    compaction: { active: false, reason: null, lastResult: null },
  };
}

/**
 * Apply a pi SDK event (already normalized by the server) to a transcript state.
 * Pure: never mutates its input; returns a new state.
 *
 * Event shape matches what the server broadcasts via WebSocket:
 *   { type: "message_start", role: "assistant" }
 *   { type: "message_update", updateType: "text_delta", delta: "..." }
 *   { type: "message_update", updateType: "thinking_delta", delta: "..." }
 *   { type: "message_end", role: "assistant" }
 *   { type: "tool_execution_start", toolName, toolCallId, args }
 *   { type: "tool_execution_end", toolName, toolCallId, isError, result: { content: [{type:"text", text}] } }
 *
 * @param {TranscriptState} state
 * @param {Record<string, unknown>} event
 * @param {number} [now] timestamp for generated messages (defaults to Date.now)
 * @returns {TranscriptState}
 */
export function reduceEvent(state, event, now) {
  const ts = now ?? Date.now();
  const messages = state.messages;
  let streamingText = state.streamingText;
  let streamingThinking = state.streamingThinking;

  switch (event.type) {
    case "agent_end":
      return {
        ...state,
        messages: messages.map((msg) => msg.toolStatus === "running" ? { ...msg, toolStatus: "unknown" } : msg),
      };

    case "queue_update": {
      // Pi emits queue_update whenever the session's steering / follow-up
      // queues change — either because the user added a message during a
      // streaming turn, or because the engine consumed one. Tracking this
      // lets the UI render queue chips above the input.
      const steering = Array.isArray(event.steering) ? [...event.steering] : [];
      const followUp = Array.isArray(event.followUp) ? [...event.followUp] : [];
      return {
        ...state,
        queue: { steering, followUp },
      };
    }

    case "compaction_start":
      // Pi fires this both for `/compact` (manual) and for auto-compaction
      // when context fills up. Either way, surface it: hold the indicator
      // open until compaction_end clears `active`.
      return {
        ...state,
        compaction: {
          active: true,
          reason: typeof event.reason === "string" ? event.reason : null,
          lastResult: state.compaction?.lastResult ?? null,
        },
      };

    case "compaction_end":
      // Keep the outcome visible until another compaction completes. Errors
      // must not be mistaken for success just because they weren't aborts.
      return {
        ...state,
        compaction: {
          active: false,
          reason: null,
          lastResult: {
            reason: typeof event.reason === "string" ? event.reason : null,
            aborted: !!event.aborted,
            willRetry: !!event.willRetry,
            errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : null,
            result: event.result && typeof event.result === "object" ? {
              tokensBefore: event.result.tokensBefore,
              estimatedTokensAfter: event.result.estimatedTokensAfter,
            } : null,
            ts,
          },
        },
      };

    case "message_start":
      if (event.role === "assistant") {
        streamingText = "";
        streamingThinking = "";
      }
      break;

    case "message_update": {
      if (event.updateType === "text_delta") {
        streamingText = streamingText + (event.delta || "");
      } else if (event.updateType === "thinking_delta") {
        streamingThinking = streamingThinking + (event.delta || "");
      }
      break;
    }

    case "message_end": {
      if (event.role === "user") {
        return appendUserMessage(state, event, ts);
      }
      if (event.role === "assistant") {
        const newMsgs = [...messages];
        if (streamingThinking) {
          newMsgs.push({ role: "thinking", content: streamingThinking, ts });
        }
        if (streamingText) {
          newMsgs.push({ role: "assistant", content: streamingText, ts });
        }
        return {
          ...state,
          messages: newMsgs,
          streamingText: "",
          streamingThinking: "",
          queue: state.queue,
        };
      }
      break;
    }

    case "tool_execution_start":
      return {
        ...state,
        messages: [
          ...messages,
          {
            role: "tool",
            content: "",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
            toolStatus: "running",
            ts,
          },
        ],
        streamingText,
        streamingThinking,
        queue: state.queue,
      };

    case "tool_execution_end": {
      let resultText = "";
      const result = event.result;
      if (result && Array.isArray(result.content)) {
        resultText = result.content
          .filter((c) => c && c.type === "text")
          .map((c) => c.text)
          .join("\n");
      }
      return {
        ...state,
        messages: [
          ...messages.map((msg) => msg.role === "tool" && event.toolCallId && msg.toolCallId === event.toolCallId
            ? { ...msg, toolStatus: event.isError ? "failed" : "completed" }
            : msg),
          {
            role: "tool_result",
            content: resultText,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            isError: !!event.isError,
            ts,
          },
        ],
        streamingText,
        streamingThinking,
        queue: state.queue,
      };
    }
  }

  return { ...state, messages, streamingText, streamingThinking };
}

/** Fold a `message_end` event for a user message into the transcript.
 *
 *  Pi emits message_start/message_end for every user turn, whoever
 *  authored it: the browser, `pru send` from a human shell, another agent
 *  delegating work, or a steering message being consumed mid-turn. Before
 *  we handled it here, only the browser tab that typed the message showed
 *  it (via the optimistic append in app.js) — everything else stayed
 *  invisible until the next history refetch on turn end, so an agent you
 *  launched-and-briefed appeared to be working on nothing.
 *
 *  The optimistic append is why this can't be a plain push: the sending
 *  tab already has the message on screen, tagged `pending`, and would
 *  otherwise show it twice. Confirming the first pending user message with
 *  matching text (rather than dropping any duplicate) keeps a deliberate
 *  "continue" / "continue" pair intact — two pendings, two confirmations.
 */
function appendUserMessage(state, event, ts) {
  const content = typeof event.text === "string" ? event.text : "";
  const images = Array.isArray(event.images) ? event.images : [];
  // Nothing to draw. Pi has no reason to emit this, but an empty row in
  // the transcript would be worse than skipping it.
  if (!content && images.length === 0) return state;

  const pendingIdx = state.messages.findIndex(
    (m) => m.role === "user" && m.pending && m.content === content,
  );
  if (pendingIdx !== -1) {
    const messages = [...state.messages];
    const { pending: _pending, ...confirmed } = messages[pendingIdx];
    messages[pendingIdx] = confirmed;
    return { ...state, messages };
  }

  return {
    ...state,
    messages: [
      ...state.messages,
      { role: "user", content, ts, ...(images.length > 0 ? { images } : {}) },
    ],
  };
}

/** Apply a sequence of events to an initial (or provided) state. */
export function reduceEvents(events, initial, now) {
  let state = initial ?? initialTranscriptState();
  for (const e of events) {
    state = reduceEvent(state, e, now);
  }
  return state;
}

// --- HTML rendering ---

/** Build a stable key for a message so expand/collapse state and DOM
 *  reconciliation both survive re-renders. Tool messages key on their
 *  call ID so collapsing/expanding doesn't move them; non-tool messages
 *  key on their array index (which is append-only in our flow). */
export function messageKey(msg, idx) {
  return msg.toolCallId ? `tc:${msg.toolCallId}:${msg.role}` : `msg:${idx}`;
}

/** Stable keys for the in-flight streaming bubbles. They share the same
 *  DOM nodes turn-after-turn, so app.js's reconciliation can update them
 *  in place rather than creating + destroying. */
export const STREAMING_TEXT_KEY = "streaming-text";
export const STREAMING_THINKING_KEY = "streaming-thinking";

/**
 * Render a single ChatMessage to HTML.
 * @param {ChatMessage} msg
 * @param {number} idx
 * @param {Set<string>} [expandedItems]
 * @param {{ rawAssistant?: boolean, agentId?: string }} [opts]
 */
/** Render an array of {dataUrl, mimeType} as a wrapping flex row of small
 *  thumbnails. Click expands the full image in a new tab (data: URL).
 *  Returns "" for an empty / missing array so callers can interpolate
 *  unconditionally. Used by both user and tool-result message renderers. */
function renderInlineImages(images) {
  if (!Array.isArray(images) || images.length === 0) return "";
  // Flat pi-cli layout: thumbnails left-align inside the message row
  // (the parent row already provides the column padding). Was
  // `justify-end max-w-[80%]` back when user messages were
  // right-aligned bubbles.
  let html = `<div class="flex flex-wrap gap-1 justify-start">`;
  for (const img of images) {
    if (!img || !isRasterDataUrl(img.dataUrl)) continue;
    const src = escHtml(img.dataUrl);
    html += `<a href="${src}" target="_blank" rel="noopener noreferrer" class="block">
      <img src="${src}" alt="attached ${escHtml(img.mimeType || "image")}" class="max-h-48 max-w-full rounded border border-base16-300 object-contain bg-base16-100" />
    </a>`;
  }
  html += `</div>`;
  return html;
}

export function renderMessage(msg, idx, expandedItems, opts) {
  const expanded = expandedItems ?? new Set();
  const rawAssistant = !!(opts && opts.rawAssistant);

  // Every top-level wrapper carries a stable `data-msg-key` so app.js's
  // reconciler can identify it across renders and avoid rebuilding the
  // entire transcript whenever a single message arrives or updates.
  // Named `wrapKey` rather than `key` to avoid shadowing the inner
  // `const key = messageKey(...)` declarations in the thinking / tool /
  // tool_result branches below (TDZ would fire otherwise).
  const wrapKey = msg.streaming
    ? (msg.role === "thinking" ? STREAMING_THINKING_KEY : STREAMING_TEXT_KEY)
    : messageKey(msg, idx);

  if (msg.role === "user") {
    // Pi-cli style: user messages are inline in the flat transcript,
    // NOT a right-aligned colored bubble. They sit at the same indent
    // as assistant content with a slightly lighter bg-tint strip
    // running the full width of the message column -- mirrors pi-tui's
    // input-recall band (visible in the user's reference screenshot:
    // "oh you made symlinks? can you just copy them in?").
    //
    // The text itself is colored slightly brighter than assistant prose
    // so you can scan the transcript and spot your own utterances
    // without needing a bubble border.
    //
    // User text goes through the SAME pi-tui markdown renderer the
    // assistant uses. Pi-cli does this -- a `> quoted line` in user
    // input renders with the `│ ` blockquote bar + italic body, bold
    // / italic / inline-code / lists all work. Falls back to the
    // plain-text `<pre>` when no widthCols (tests / preview).
    //
    // Image attachments stack above the text on the same row.
    const imagesHtml = renderInlineImages(msg.images);
    let userBody = "";
    if (msg.content) {
      if (opts && opts.widthCols) {
        userBody = renderMessageMarkdown(msg.content, { widthCols: opts.widthCols });
      } else {
        userBody = `<pre class="whitespace-pre-wrap">${escHtml(msg.content)}</pre>`;
      }
    }
    return `
      <div class="message-enter pi-row pi-row-user flex flex-col gap-1 px-4 py-3" data-msg-key="${wrapKey}">
        ${imagesHtml}
        ${userBody ? renderMessagePreview(userBody, wrapKey, expanded, "message") : ""}
      </div>`;
  }

  if (msg.role === "assistant") {
    if (msg.streaming) {
      // Use exactly the same renderer as app.js's incremental updates.
      // The stable outer div allows switching between terminal <pre> and
      // flow-layout math without putting block elements inside a <pre>.
      const streamBody = renderMessageMarkdown(msg.content, {
        widthCols: opts?.widthCols,
        raw: rawAssistant || !opts?.widthCols,
        cursor: '<span class="animate-pulse text-base16-green streaming-cursor">▊</span>',
      });
      return `
        <div class="message-enter pi-row pi-row-assistant px-4 py-1.5" data-msg-key="${wrapKey}">
          <div id="streaming-body">${streamBody}</div>
        </div>`;
    }
    // Math uses browser flow layout; ordinary messages retain the
    // width-aware terminal renderer. The raw toggle bypasses both.
    const body = renderMessageMarkdown(msg.content, {
      widthCols: opts?.widthCols,
      raw: rawAssistant,
      agentId: opts?.agentId,
    });
    return `
      <div class="message-enter pi-row pi-row-assistant px-4 py-1.5" data-msg-key="${wrapKey}">
        ${body}
      </div>`;
  }

  if (msg.role === "thinking") {
    return `
      <div class="message-enter pi-row pi-row-thinking px-4 py-1" data-msg-key="${escHtml(wrapKey)}">
        <div class="italic text-base16-500 mb-1">thinking${msg.streaming ? "…" : ""}</div>
        <div${msg.streaming ? ' id="streaming-thinking-body"' : ""} class="thinking-content">${renderThinkingBody(msg.content, wrapKey, expanded, opts, msg.streaming)}</div>
      </div>`;
  }

  if (msg.role === "tool") {
    const desc = describeToolCall(msg.toolName, msg.args);
    const key = messageKey(msg, idx);
    const args = parseToolArgs(msg.args);
    const language = desc.language || (msg.toolName?.toLowerCase() === "write"
      ? toolLanguageFromPath(args?.path || args?.file_path) : "");
    const status = msg.toolStatus === "running" && opts?.agentRunning === false ? "unknown" : msg.toolStatus;
    const bodyHtml = renderToolBody({ ...desc, language, key, expanded, label: "Input" });
    // Bash commands live in the highlighted body, not a duplicated/truncated subtitle.
    const subtitle = msg.toolName?.toLowerCase() === "bash" ? "" : desc.subtitle;
    return `
      <div class="message-enter pi-row pi-row-tool pi-row-tool-call px-4 py-1" data-msg-key="${escHtml(key)}">
        <div class="tool-header">
          <span class="text-base16-cyan font-semibold">${escHtml(desc.header)}</span>
          ${subtitle ? `<span class="tool-subtitle">${escHtml(subtitle)}</span>` : ""}
          ${renderToolStatus(status)}
        </div>
        ${bodyHtml}
      </div>`;
  }

  if (msg.role === "tool_result") {
    const isError = !!msg.isError;
    const contentStr = typeof msg.content === "string" ? msg.content : String(msg.content ?? "");
    const summary = describeToolResult(msg.toolName, contentStr, isError);
    const key = messageKey(msg, idx);
    // Some tools answer with boilerplate written for the model (todo
    // lists say "…continue to use the todo list…" after every write).
    // The call row already shows the content; drop the echo.
    const hasBody =
      contentStr.trim().length > 0 && !hidesToolResultBody(msg.toolName, isError);
    const toolName = msg.toolName || "done";
    // Image attachments stay visible independently of the text preview.
    const imagesHtml = renderInlineImages(msg.images);
    const hasImages = imagesHtml.length > 0;
    const bodyHtml = hasBody
      ? renderToolBody({ body: contentStr, language: toolResultLanguage(msg.toolName, msg.args, contentStr, isError), key, expanded, label: "Output" })
      : "";
    const imagesWrap = hasImages ? `<div class="mt-1">${imagesHtml}</div>` : "";
    const imageLabelSuffix = hasImages
      ? ` <span class="text-base16-500">· ${msg.images.length} image${msg.images.length === 1 ? "" : "s"}</span>`
      : "";
    const nameClass = isError ? "text-base16-red font-semibold" : "text-base16-cyan font-semibold";
    return `
      <div class="message-enter pi-row pi-row-tool pi-row-tool-result px-4 py-1" data-msg-key="${escHtml(key)}">
        <div class="tool-header">
          <span class="${nameClass}">${escHtml(toolName)}</span>
          ${summary ? `<span class="text-base16-500">— ${escHtml(summary)}</span>` : ""}
          ${imageLabelSuffix}
          ${renderToolStatus(isError ? "failed" : "completed")}
        </div>
        ${bodyHtml}
        ${imagesWrap}
      </div>`;
  }

  if (msg.role === "system") {
    return `
      <div class="message-enter pi-row pi-row-system px-4 py-1" data-msg-key="${wrapKey}">
        <div class="text-base16-orange/80 bg-base16-orange/10 rounded px-2 py-1">${escHtml(msg.content)}</div>
      </div>`;
  }

  return "";
}

/** Shared by the initial row and incremental thinking updates. Markdown and
 * folding stay identical while streaming and after a turn is finalized. */
export function renderThinkingBody(text, key, expanded, opts, streaming = false) {
  const body = renderMessageMarkdown(text, {
    widthCols: opts?.widthCols,
    cursor: streaming ? '<span class="animate-pulse text-base16-500 streaming-cursor">▊</span>' : "",
  });
  return renderMessagePreview(body, key, expanded, "thinking");
}

function renderToolStatus(status) {
  const label = { running: "Running", completed: "Completed", failed: "Failed" }[status] || "No result";
  const state = ["running", "completed", "failed"].includes(status) ? status : "unknown";
  return `<span class="tool-status tool-status-${state}"${state === "running" ? ' role="status"' : ""}>${state === "running" ? '<span class="tool-spinner" aria-hidden="true"></span>' : ""}${label}</span>`;
}

/** Render a full transcript (final messages + in-flight streaming).
 *  Returns an HTML string.
 *
 *  Tool inputs and outputs each show a compact preview by default; keys in
 *  expandedItems reveal their full content, independently of other rows.
 *
 *  Pass `opts.rawAssistant = true` to render every assistant message as its
 *  plain markdown source instead of rendered HTML (global raw-view toggle).
 *
 *  @param {TranscriptState} state
 *  @param {Set<string>} [expandedItems]
 *  @param {{ rawAssistant?: boolean, agentId?: string }} [opts]
 */
export function renderTranscript(state, expandedItems, opts) {
  return renderTranscriptBlocks(state, expandedItems, opts)
    .map((b) => b.html)
    .join("");
}

/** Same content as `renderTranscript`, but split into per-message blocks
 *  with stable `key`s so app.js can reconcile against the existing DOM and
 *  avoid rebuilding the whole transcript on every event. Each `key` matches
 *  the `data-msg-key` attribute on the block's top-level wrapper.
 *
 *  Blocks emitted, in order:
 *    1. Each message rendered as its own row, keyed by
 *       `messageKey(msg, idx)` for non-tool messages and
 *       `tc:<callId>:<role>` for tool / tool_result rows.
 *    2. Streaming thinking bubble if any (key = `STREAMING_THINKING_KEY`)
 *    3. Streaming text bubble if any   (key = `STREAMING_TEXT_KEY`)
 *
 *  Previously consecutive tool/tool_result messages were grouped into a
 *  collapsible `<run:...>` widget showing `▸ N tool calls`. That widget
 *  doesn't exist in pi-cli -- pi prints each tool call inline with the
 *  surrounding prose, no group header, no fold. Tool name in cyan, tool
 *  body dim. We match that here by emitting per-message blocks always.
 *  Per-message chevrons still let the user expand/collapse a single tool
 *  body when its output is long.
 *
 *  @param {TranscriptState} state
 *  @param {Set<string>} [expandedItems]
 *  @param {{ rawAssistant?: boolean, agentId?: string }} [opts]
 *  @returns {{ key: string, html: string }[]}
 */
export function renderTranscriptBlocks(state, expandedItems, opts) {
  const expanded = expandedItems ?? new Set();
  const renderOpts = opts ?? {};
  const blocks = [];
  const msgs = state.messages;

  // Join by call ID, not adjacency: parallel tools can finish out of order.
  // History has no live status field; a matching result is proof of completion.
  const calls = new Map();
  const results = new Map();
  for (const msg of msgs) {
    if (!msg.toolCallId) continue;
    if (msg.role === "tool") calls.set(msg.toolCallId, msg);
    if (msg.role === "tool_result") results.set(msg.toolCallId, msg);
  }
  for (let i = 0; i < msgs.length; i++) {
    let msg = msgs[i];
    const result = msg.toolCallId && results.get(msg.toolCallId);
    if (msg.role === "tool" && result) {
      msg = { ...msg, toolStatus: result.isError ? "failed" : "completed" };
    } else if (msg.role === "tool_result" && msg.toolCallId) {
      msg = { ...msg, args: calls.get(msg.toolCallId)?.args };
    }
    blocks.push({
      key: messageKey(msg, i),
      html: renderMessage(msg, i, expanded, renderOpts),
    });
  }

  // Streaming bubbles use stable keys so they share DOM across deltas.
  const i0 = msgs.length;
  if (state.streamingThinking) {
    blocks.push({
      key: STREAMING_THINKING_KEY,
      html: renderMessage(
        { role: "thinking", content: state.streamingThinking, ts: Date.now(), streaming: true },
        i0,
        expanded,
        renderOpts,
      ),
    });
  }
  if (state.streamingText) {
    blocks.push({
      key: STREAMING_TEXT_KEY,
      html: renderMessage(
        { role: "assistant", content: state.streamingText, ts: Date.now(), streaming: true },
        i0 + 1,
        expanded,
        renderOpts,
      ),
    });
  }

  // Compaction status row. Sits at the bottom of the transcript so it
  // doesn't displace existing messages mid-stream. Two cases:
  //   1. active: "compacting context…" with a pulsing dot.
  //   2. last result: a one-liner showing what happened (briefly).
  // We always render at least one of these when there's compaction state
  // to surface; both share the same data-msg-key so they swap in place
  // when the active state flips off.
  const c = state.compaction;
  if (c && (c.active || c.lastResult)) {
    blocks.push({
      key: COMPACTION_KEY,
      html: renderCompactionRow(c),
    });
  }
  return blocks;
}

/** Stable key for the compaction-status block. Mirrors STREAMING_*_KEY —
 *  the row swaps between "compacting…" and "compacted" content but keeps
 *  the same DOM node, so reconciliation is a single innerHTML swap. */
export const COMPACTION_KEY = "compaction";

function compactionReasonLabel(reason) {
  const label = {
    manual: "manual",
    auto: "automatic",
    threshold: "automatic threshold",
    overflow: "context recovery",
  }[reason];
  return label ? ` (${label})` : "";
}

function renderCompactionRow(c) {
  if (c.active) {
    const reasonLabel = compactionReasonLabel(c.reason);
    return `
      <div class="message-enter px-2 py-1" data-msg-key="${COMPACTION_KEY}">
        <div class="flex items-baseline gap-2 text-xs font-mono text-base16-orange bg-base16-orange/10 border border-base16-orange/20 rounded px-2 py-1">
          <span class="pulse-dot text-base16-orange">●</span>
          <span>compacting context…${escHtml(reasonLabel)}</span>
        </div>
      </div>`;
  }
  const r = c.lastResult;
  if (!r) return "";
  const reasonLabel = compactionReasonLabel(r.reason);
  if (r.aborted) {
    return `
      <div class="message-enter px-2 py-1" data-msg-key="${COMPACTION_KEY}">
        <div class="flex items-baseline gap-2 text-xs font-mono text-base16-red bg-base16-red/10 border border-base16-red/20 rounded px-2 py-1">
          <span>×</span>
          <span>compaction aborted${escHtml(reasonLabel)}${r.willRetry ? " (will retry)" : ""}</span>
        </div>
      </div>`;
  }
  if (r.errorMessage) {
    return `
      <div class="message-enter px-2 py-1" data-msg-key="${COMPACTION_KEY}">
        <div role="alert" class="text-xs font-mono text-base16-red bg-base16-red/10 border border-base16-red/20 rounded px-2 py-1">
          <div>× compaction failed${escHtml(reasonLabel)}</div>
          <div class="whitespace-pre-wrap break-words mt-1">${escHtml(r.errorMessage)}</div>
          <div class="mt-1">The agent may need a manual /compact or /handoff to continue.</div>
        </div>
      </div>`;
  }
  if (!r.result) {
    // Older servers omit the result. An unknown outcome is not success.
    return `
      <div class="message-enter px-2 py-1" data-msg-key="${COMPACTION_KEY}">
        <div class="text-xs font-mono text-base16-orange bg-base16-orange/10 border border-base16-orange/20 rounded px-2 py-1">
          <span>compaction ended without a result${escHtml(reasonLabel)}</span>
        </div>
      </div>`;
  }
  const { tokensBefore, estimatedTokensAfter } = r.result;
  const tokenLabel = Number.isFinite(tokensBefore) && tokensBefore >= 0 &&
    Number.isFinite(estimatedTokensAfter) && estimatedTokensAfter >= 0
    ? ` — ${tokensBefore.toLocaleString("en-US")} → ~${estimatedTokensAfter.toLocaleString("en-US")} tokens`
    : "";
  return `
    <div class="message-enter px-2 py-1" data-msg-key="${COMPACTION_KEY}">
      <div class="flex items-baseline gap-2 text-xs font-mono text-base16-green bg-base16-green/10 border border-base16-green/20 rounded px-2 py-1">
        <span>✓</span>
        <span>context compacted${escHtml(reasonLabel)}${escHtml(tokenLabel)}</span>
      </div>
    </div>`;
}

// Re-export helpers app.js needs.
export { shortenPath, relTime };
