// Transcript rendering and event-reduction logic.
// Pure ES module — no DOM access. Import from both browser (app.js) and tests.

import {
  describeToolCall,
  describeToolResult,
  enhanceImagePaths,
  escHtml,
  relTime,
  renderMarkdown,
  shortenPath,
} from "./render.js";
import { renderMarkdownPi } from "./pi-markdown.js";

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
      // Result lingers (rendered as a small system-style line) so the user
      // can confirm the compaction succeeded. The next compaction_start
      // will overwrite it.
      return {
        ...state,
        compaction: {
          active: false,
          reason: null,
          lastResult: {
            reason: typeof event.reason === "string" ? event.reason : null,
            aborted: !!event.aborted,
            willRetry: !!event.willRetry,
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
      if (event.role === "assistant") {
        const newMsgs = [...messages];
        if (streamingThinking) {
          newMsgs.push({ role: "thinking", content: streamingThinking, ts });
        }
        if (streamingText) {
          newMsgs.push({ role: "assistant", content: streamingText, ts });
        }
        return {
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
        messages: [
          ...messages,
          {
            role: "tool",
            content: "",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
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
      if (resultText.length > 2000) {
        resultText = resultText.slice(0, 2000) + "\n…(truncated)";
      }
      return {
        messages: [
          ...messages,
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

  return { messages, streamingText, streamingThinking, queue: state.queue };
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
    if (!img || typeof img.dataUrl !== "string") continue;
    html += `<a href="${img.dataUrl}" target="_blank" rel="noopener" class="block">
      <img src="${img.dataUrl}" alt="attached ${escHtml(img.mimeType || "image")}" class="max-h-48 max-w-full rounded border border-base16-300 object-contain bg-base16-100" />
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
        userBody = `<pre class="pi-md">${renderMarkdownPi(msg.content, opts.widthCols)}</pre>`;
      } else {
        userBody = `<pre class="whitespace-pre-wrap">${escHtml(msg.content)}</pre>`;
      }
    }
    return `
      <div class="message-enter pi-row pi-row-user flex flex-col gap-1 px-4 py-3" data-msg-key="${wrapKey}">
        ${imagesHtml}
        ${userBody}
      </div>`;
  }

  if (msg.role === "assistant") {
    if (msg.streaming) {
      // Streaming row: flat pi-cli layout (no bubble). Renders plain
      // text -- NOT markdown -- for the reasons in the original
      // comment: half-formed markdown flickers, and rebuilding the
      // DOM on every delta causes flash. app.js's
      // updateStreamingElement() inserts new text before the cursor
      // span instead of rewriting innerHTML, so streaming stays
      // smooth. message_complete swaps to the pi-md branch above
      // for the final paint.
      return `
        <div class="message-enter pi-row pi-row-assistant px-4 py-1.5" data-msg-key="${wrapKey}">
          <pre id="streaming-body" class="whitespace-pre-wrap text-base16-600 font-mono">${escHtml(msg.content)}<span class="animate-pulse text-base16-green streaming-cursor">▊</span></pre>
        </div>`;
    }
    // `rawAssistant` toggle (owned by app.js, localStorage-backed) --
    // flipped via the `raw` button. When on, every assistant message
    // renders as plain escaped markdown source.
    //
    // Default path: pi-tui box-drawing renderer (renderMarkdownPi),
    // width-tied to the bubble's column capacity. The whole pi-md
    // block sits inline in the flat transcript -- no bubble border,
    // no left/right alignment, just full-column flow that matches
    // pi-cli.
    let body;
    if (rawAssistant) {
      body = `<pre class="whitespace-pre-wrap text-base16-600 font-mono">${escHtml(msg.content)}</pre>`;
    } else if (opts && opts.widthCols) {
      const pi = renderMarkdownPi(msg.content, opts.widthCols);
      // enhanceImagePaths returns { html, thumbnails }: thumbnails
      // render BELOW the <pre class="pi-md"> block (not inside it)
      // because injecting `<a><img>` into a `white-space: pre` block
      // would break the column-aligned text layout. Image-path
      // references in inline code (<span class="pi-code">foo.png</span>)
      // become thumbnail tiles in the strip.
      const { html: piHtml, thumbnails } = opts.agentId
        ? enhanceImagePaths(pi, opts.agentId)
        : { html: pi, thumbnails: "" };
      body = `<pre class="pi-md">${piHtml}</pre>${thumbnails}`;
    } else {
      // Fallback for tests / preview where no width is available.
      const md = renderMarkdown(msg.content);
      const { html: enhancedHtml, thumbnails } = opts && opts.agentId
        ? enhanceImagePaths(md, opts.agentId)
        : { html: md, thumbnails: "" };
      body = `<div class="md text-base16-600">${enhancedHtml}</div>${thumbnails}`;
    }
    return `
      <div class="message-enter pi-row pi-row-assistant px-4 py-1.5" data-msg-key="${wrapKey}">
        ${body}
      </div>`;
  }

  if (msg.role === "thinking") {
    // Streaming path: render a simple auto-scrolling live box so the
    // text keeps flowing without triggering layout churn. The id is
    // stable so app.js can update the innerHTML in place on each
    // thinking_delta.
    //
    // Pi-cli prints thinking lines as italic + muted at the same size
    // as surrounding prose. We match by inheriting the transcript's
    // 14 px / 20 px rhythm via `.pi-row-thinking` (no text-[11px]).
    if (msg.streaming) {
      return `
        <div class="message-enter pi-row pi-row-thinking px-4 py-1" data-msg-key="${wrapKey}">
          <div class="italic text-base16-500 mb-1">thinking…</div>
          <pre id="streaming-thinking-body" class="text-base16-500 italic whitespace-pre-wrap max-h-48 overflow-y-auto">${escHtml(msg.content)}<span class="animate-pulse text-base16-500">▊</span></pre>
        </div>`;
    }
    // Finalized path: first-line preview + expand/collapse for the rest.
    const key = messageKey(msg, idx);
    const isExpanded = expanded.has(key);
    const preview = msg.content.split("\n")[0].slice(0, 120);
    const hasMore = msg.content.length > preview.length;
    const chevron = hasMore ? `<span class="text-base16-500 ml-auto">${isExpanded ? "▼" : "▶"}</span>` : "";
    return `
      <div class="message-enter pi-row pi-row-thinking px-4 py-1" data-msg-key="${key}">
        <div class="flex items-baseline gap-2 italic cursor-pointer hover:bg-base16-200/50 rounded px-1 py-0.5" data-toggle="${hasMore ? key : ""}">
          <span class="text-base16-500">thinking</span>
          <span class="text-base16-500 truncate italic">${escHtml(preview)}${hasMore && !isExpanded ? "…" : ""}</span>
          ${chevron}
        </div>
        ${hasMore ? `<pre class="mt-1 text-base16-500 italic whitespace-pre-wrap ${isExpanded ? "" : "hidden"}" data-expand="${key}">${escHtml(msg.content)}</pre>` : ""}
      </div>`;
  }

  // Tool / tool_result rows: pi-cli renders these inline in the
  // transcript, ALWAYS expanded, NO chevron. Color is the only
  // differentiator from assistant prose:
  //   - tool name -> cyan accent (text-base16-cyan)
  //   - args / subtitle -> muted (text-base16-500)
  //   - body / output -> muted (text-base16-500)
  //   - assistant prose stays at default (~ text-base16-700)
  // No bg-tint, no border bar, no fold. The whole row is read-only;
  // the user can't collapse a tool body, matching pi-cli's behavior.
  if (msg.role === "tool") {
    const desc = describeToolCall(msg.toolName, msg.args);
    const key = messageKey(msg, idx);
    const hasBody = desc.body && desc.body.length > 0;
    const bodyHtml = !hasBody
      ? ""
      : desc.bodyIsRich
        ? `<div class="mt-1">${desc.body}</div>`
        : `<pre class="mt-1 text-base16-500 whitespace-pre-wrap">${escHtml(desc.body)}</pre>`;
    return `
      <div class="message-enter pi-row pi-row-tool pi-row-tool-call px-4 py-1" data-msg-key="${key}">
        <div class="flex items-baseline gap-2 px-1">
          <span class="text-base16-cyan font-semibold">${escHtml(desc.header)}</span>
          ${desc.subtitle ? `<span class="text-base16-500 truncate">${escHtml(desc.subtitle)}</span>` : ""}
        </div>
        ${bodyHtml}
      </div>`;
  }

  if (msg.role === "tool_result") {
    const isError = !!msg.isError;
    const icon = isError ? "✗" : "✓";
    const color = isError ? "text-base16-red" : "text-base16-green";
    const contentStr = typeof msg.content === "string" ? msg.content : String(msg.content ?? "");
    const summary = describeToolResult(msg.toolName, contentStr, isError);
    const key = messageKey(msg, idx);
    const hasBody = contentStr.trim().length > 0;
    const toolName = msg.toolName || "done";
    // Images render alongside the text body. The text body is always
    // visible (no chevron gate) so pi-cli's auto-expand semantics
    // hold for both text + image content.
    const imagesHtml = renderInlineImages(msg.images);
    const hasImages = imagesHtml.length > 0;
    const bodyHtml = hasBody
      ? `<pre class="mt-1 text-base16-500 whitespace-pre-wrap">${escHtml(contentStr)}</pre>`
      : "";
    const imagesWrap = hasImages ? `<div class="mt-1">${imagesHtml}</div>` : "";
    const imageLabelSuffix = hasImages
      ? ` <span class="text-base16-500">· ${msg.images.length} image${msg.images.length === 1 ? "" : "s"}</span>`
      : "";
    // No icon glyph -- per user request, the green ✓ / red ✗ marker
    // is dropped. Tool name still uses the cyan accent for success;
    // errors switch the name to red so the failure signal isn't
    // lost. Summary stays muted.
    const nameClass = isError ? "text-base16-red font-semibold" : "text-base16-cyan font-semibold";
    return `
      <div class="message-enter pi-row pi-row-tool pi-row-tool-result px-4 py-1" data-msg-key="${key}">
        <div class="flex items-baseline gap-2 px-1">
          <span class="${nameClass}">${escHtml(toolName)}</span>
          ${summary ? `<span class="text-base16-500">— ${escHtml(summary)}</span>` : ""}
          ${imageLabelSuffix}
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

// v0.12.6 dropped the collapsible "X tool calls" grouping widget --
// pi-cli has no such concept. Tool/tool_result messages now render as
// individual flat rows in the transcript, with per-row chevrons for
// expanding long bodies. `isToolRow` / `summarizeToolRun` /
// `renderToolRun` helpers were removed alongside.

/** Render a full transcript (final messages + in-flight streaming).
 *  Returns an HTML string.
 *
 *  Groups consecutive tool/tool_result messages into collapsible runs.
 *  A run that's followed by any non-tool message (assistant, user, system)
 *  is considered *completed* and renders collapsed by default. A run that
 *  reaches the end of the transcript is *live* (agent's current turn) and
 *  renders expanded so the user can watch work happen in real time.
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

  for (let i = 0; i < msgs.length; i++) {
    blocks.push({
      key: messageKey(msgs[i], i),
      html: renderMessage(msgs[i], i, expanded, renderOpts),
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

function renderCompactionRow(c) {
  if (c.active) {
    const reason = c.reason === "manual" ? "manual" : c.reason === "auto" ? "auto" : null;
    const reasonLabel = reason ? ` (${reason})` : "";
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
  const reason = r.reason === "manual" ? "manual" : r.reason === "auto" ? "auto" : null;
  const reasonLabel = reason ? ` (${reason})` : "";
  if (r.aborted) {
    return `
      <div class="message-enter px-2 py-1" data-msg-key="${COMPACTION_KEY}">
        <div class="flex items-baseline gap-2 text-xs font-mono text-base16-red bg-base16-red/10 border border-base16-red/20 rounded px-2 py-1">
          <span>×</span>
          <span>compaction aborted${escHtml(reasonLabel)}${r.willRetry ? " (will retry)" : ""}</span>
        </div>
      </div>`;
  }
  return `
    <div class="message-enter px-2 py-1" data-msg-key="${COMPACTION_KEY}">
      <div class="flex items-baseline gap-2 text-xs font-mono text-base16-green bg-base16-green/10 border border-base16-green/20 rounded px-2 py-1">
        <span>✓</span>
        <span>context compacted${escHtml(reasonLabel)}</span>
      </div>
    </div>`;
}

// Re-export helpers app.js needs.
export { shortenPath, relTime };
