// Transcript rendering and event-reduction logic.
// Pure ES module — no DOM access. Import from both browser (app.js) and tests.

import {
  describeToolCall,
  describeToolResult,
  escHtml,
  relTime,
  renderMarkdown,
  shortenPath,
} from "./render.js";

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
 * @param {{ rawAssistant?: boolean }} [opts]
 */
/** Render an array of {dataUrl, mimeType} as a wrapping flex row of small
 *  thumbnails. Click expands the full image in a new tab (data: URL).
 *  Returns "" for an empty / missing array so callers can interpolate
 *  unconditionally. Used by both user and tool-result message renderers. */
function renderInlineImages(images) {
  if (!Array.isArray(images) || images.length === 0) return "";
  let html = `<div class="flex flex-wrap gap-1 justify-end max-w-[80%]">`;
  for (const img of images) {
    if (!img || typeof img.dataUrl !== "string") continue;
    html += `<a href="${img.dataUrl}" target="_blank" rel="noopener" class="block">
      <img src="${img.dataUrl}" alt="attached ${escHtml(img.mimeType || "image")}" class="max-h-48 max-w-full rounded-lg border border-base16-300 object-contain bg-base16-100" />
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
    // Image attachments (pasted into the input on the way out, or stored
    // on the message after a roundtrip via getMessages). Inlined as data
    // URIs from the server -- no extra fetches. Multiple images stack as
    // a wrapping flex row above the text bubble.
    const imagesHtml = renderInlineImages(msg.images);
    return `
      <div class="message-enter flex flex-col items-end gap-1" data-msg-key="${wrapKey}">
        ${imagesHtml}
        ${
          msg.content
            ? `<div class="max-w-[80%] bg-base16-blue/15 border border-base16-blue/20 rounded-xl px-4 py-2">
          <pre class="whitespace-pre-wrap text-base16-700 text-base font-sans">${escHtml(msg.content)}</pre>
        </div>`
            : ""
        }
      </div>`;
  }

  if (msg.role === "assistant") {
    if (msg.streaming) {
      // Streaming bubble: render plain text, NOT markdown. We do this for
      // two reasons:
      //   1. Markdown of in-progress text is often half-formed (`** bold`
      //      with no closing) which causes weird flickers as fragments
      //      flip in/out of styled state.
      //   2. `el.innerHTML = renderMarkdown(...)` per delta tears down all
      //      child nodes (incl. hljs spans) and rebuilds them; that's the
      //      "flash" the user reported.
      // app.js's updateStreamingElement() exploits this: it inserts new
      // text as a text node before the cursor span instead of rewriting
      // innerHTML, so streaming is silky-smooth.
      // The bubble swaps to a markdown-rendered finalized version on
      // message_complete (one swap = one paint, much less noticeable).
      return `
        <div class="message-enter flex justify-start" data-msg-key="${wrapKey}">
          <div class="max-w-[90%] bg-base16-200 border border-base16-green/40 rounded-xl px-4 py-2">
            <pre id="streaming-body" class="whitespace-pre-wrap text-base16-600 text-base font-sans">${escHtml(msg.content)}<span class="animate-pulse text-base16-green streaming-cursor">▊</span></pre>
          </div>
        </div>`;
    }
    // `rawAssistant` is a global toggle owned by app.js (localStorage-backed)
    // — flipped via the `raw` button in the agent header. When on, every
    // assistant message renders as plain escaped markdown source.
    const body = rawAssistant
      ? `<pre class="whitespace-pre-wrap text-base16-600 text-base font-mono">${escHtml(msg.content)}</pre>`
      : `<div class="md text-base16-600 text-base">${renderMarkdown(msg.content)}</div>`;
    return `
      <div class="message-enter flex justify-start" data-msg-key="${wrapKey}">
        <div class="max-w-[90%] bg-base16-200 border border-base16-300 rounded-xl px-4 py-2">
          ${body}
        </div>
      </div>`;
  }

  if (msg.role === "thinking") {
    // Streaming path: render a simple auto-scrolling live box so the text
    // keeps flowing without triggering layout churn or chevron flicker.
    // The id is stable so app.js can update the innerHTML in place on each
    // thinking_delta.
    if (msg.streaming) {
      return `
        <div class="message-enter px-2 py-0.5" data-msg-key="${wrapKey}">
          <div class="text-[10px] italic text-base16-500 mb-1">thinking…</div>
          <pre id="streaming-thinking-body" class="text-[11px] text-base16-500 italic bg-base16-100 rounded p-2 overflow-x-auto whitespace-pre-wrap font-sans max-h-48 overflow-y-auto">${escHtml(msg.content)}<span class="animate-pulse text-base16-500">▊</span></pre>
        </div>`;
    }
    // Finalized path: first-line preview + expand/collapse for the rest.
    const key = messageKey(msg, idx);
    const isExpanded = expanded.has(key);
    const preview = msg.content.split("\n")[0].slice(0, 120);
    const hasMore = msg.content.length > preview.length;
    const chevron = hasMore ? `<span class="text-[9px] text-base16-500 ml-auto">${isExpanded ? "▼" : "▶"}</span>` : "";
    return `
      <div class="message-enter px-2 py-0.5" data-msg-key="${key}">
        <div class="flex items-baseline gap-2 text-xs italic cursor-pointer hover:bg-base16-200/50 rounded px-1 py-0.5" data-toggle="${hasMore ? key : ""}">
          <span class="text-base16-500">thinking</span>
          <span class="text-base16-500 truncate italic font-sans">${escHtml(preview)}${hasMore && !isExpanded ? "…" : ""}</span>
          ${chevron}
        </div>
        ${hasMore ? `<pre class="mt-1 text-[11px] text-base16-500 italic bg-base16-100 rounded p-2 overflow-x-auto whitespace-pre-wrap font-sans ${isExpanded ? "" : "hidden"}" data-expand="${key}">${escHtml(msg.content)}</pre>` : ""}
      </div>`;
  }

  if (msg.role === "tool") {
    const desc = describeToolCall(msg.toolName, msg.args);
    const key = messageKey(msg, idx);
    const isExpanded = expanded.has(key);
    const hasBody = desc.body && desc.body.length > 0;
    const chevron = hasBody ? `<span class="text-[9px] text-base16-500 ml-auto">${isExpanded ? "▼" : "▶"}</span>` : "";
    const bodyHtml = !hasBody
      ? ""
      : desc.bodyIsRich
        ? `<div class="mt-1 ${isExpanded ? "" : "hidden"}" data-expand="${key}">${desc.body}</div>`
        : `<pre class="mt-1 text-[11px] text-base16-500 bg-base16-100 rounded p-2 overflow-x-auto whitespace-pre-wrap ${isExpanded ? "" : "hidden"}" data-expand="${key}">${escHtml(desc.body)}</pre>`;
    const clickable = hasBody ? "cursor-pointer hover:bg-base16-200/50" : "";
    return `
      <div class="message-enter px-2 py-0.5" data-msg-key="${key}">
        <div class="flex items-baseline gap-2 text-xs font-mono ${clickable} rounded px-1 py-0.5" data-toggle="${hasBody ? key : ""}">
          <span class="text-base16-cyan">▶</span>
          <span class="text-base16-600 font-semibold">${escHtml(desc.header)}</span>
          ${desc.subtitle ? `<span class="text-base16-500 truncate">${escHtml(desc.subtitle)}</span>` : ""}
          ${chevron}
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
    const isExpanded = expanded.has(key);

    const hasBody = contentStr.trim().length > 0;
    const label = summary
      ? `${icon} ${msg.toolName || "done"} — ${summary}`
      : `${icon} ${msg.toolName || "done"}`;
    const chevron = hasBody ? `<span class="text-[9px] text-base16-500 ml-auto">${isExpanded ? "▼" : "▶"}</span>` : "";
    // Tool results can also include image content blocks (e.g. a
    // screenshot tool returning a PNG). Render them inline, below the
    // tool-result one-liner, gated by the same expand chevron as the
    // text body. If there are images but no text, the chevron is still
    // useful so we treat hasImages the same as hasBody for click-to-expand.
    const imagesHtml = renderInlineImages(msg.images);
    const hasImages = imagesHtml.length > 0;
    const expandable = hasBody || hasImages;
    const bodyHtml = hasBody
      ? `<pre class="mt-1 text-[11px] text-base16-500 bg-base16-100 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-64 ${isExpanded ? "" : "hidden"}" data-expand="${key}">${escHtml(contentStr)}</pre>`
      : "";
    const imagesWrap = hasImages
      ? `<div class="mt-1 ${isExpanded ? "" : "hidden"}" data-expand="${key}">${imagesHtml}</div>`
      : "";
    const clickable = expandable ? "cursor-pointer hover:bg-base16-200/50" : "";
    return `
      <div class="message-enter px-2 py-0.5" data-msg-key="${key}">
        <div class="flex items-baseline gap-2 text-xs font-mono ${clickable} rounded px-1 py-0.5" data-toggle="${expandable ? key : ""}">
          <span class="${color} font-semibold">${escHtml(label)}</span>
          ${expandable ? `<span class="text-[9px] text-base16-500 ml-auto">${isExpanded ? "\u25bc" : "\u25b6"}</span>` : ""}
        </div>
        ${bodyHtml}
        ${imagesWrap}
      </div>`;
  }

  if (msg.role === "system") {
    return `
      <div class="message-enter px-2 py-1" data-msg-key="${wrapKey}">
        <div class="text-xs text-base16-orange/80 font-mono bg-base16-orange/10 rounded px-2 py-1">${escHtml(msg.content)}</div>
      </div>`;
  }

  return "";
}

/** Is this a tool call / tool result row? Used to group consecutive runs. */
function isToolRow(msg) {
  return msg.role === "tool" || msg.role === "tool_result";
}

/** Build a short human summary of a tool run, e.g. `bash · read · edit` or
 *  `bash · read · edit +2 more`. Dedupes by tool name. */
function summarizeToolRun(msgs) {
  const names = [];
  const seen = new Set();
  for (const m of msgs) {
    const n = m.toolName || (m.role === "tool" ? "tool" : "result");
    if (m.role !== "tool") continue; // count only calls, not results
    if (seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  if (names.length <= 3) return names.join(" · ");
  return `${names.slice(0, 3).join(" · ")} +${names.length - 3} more`;
}

/** Wrap a completed run of tool rows in a collapsible widget. */
function renderToolRun(run, firstIdx, expanded, renderOpts) {
  const calls = run.filter((m) => m.role === "tool").length;
  const errors = run.filter((m) => m.role === "tool_result" && m.isError).length;
  const key = `run:${firstIdx}:${firstIdx + run.length - 1}`;
  const isExpanded = expanded.has(key);
  const summary = summarizeToolRun(run);
  const errSuffix = errors > 0 ? ` · ${errors} error${errors === 1 ? "" : "s"}` : "";
  const header = `${calls} tool call${calls === 1 ? "" : "s"}${summary ? " · " + summary : ""}${errSuffix}`;
  const arrow = isExpanded ? "▼" : "▸";
  const bodyHtml = isExpanded
    ? run
        .map((m, i) => renderMessage(m, firstIdx + i, expanded, renderOpts))
        .join("")
    : "";
  const errColor = errors > 0 ? "text-base16-red" : "text-base16-500";
  return `
    <div class="message-enter px-2 py-0.5" data-msg-key="${key}">
      <div class="flex items-baseline gap-2 text-xs font-mono cursor-pointer hover:bg-base16-200/50 rounded px-1 py-0.5" data-toggle="${key}">
        <span class="text-base16-500">${arrow}</span>
        <span class="${errColor}">${escHtml(header)}</span>
      </div>
      ${isExpanded ? `<div class="ml-3 border-l border-base16-300/50 pl-2" data-expand="${key}">${bodyHtml}</div>` : ""}
    </div>`;
}

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
 *  @param {{ rawAssistant?: boolean }} [opts]
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
 *    1. Each finalized non-tool message (key = `messageKey(msg, idx)`)
 *    2. Each completed tool run (key = `run:<firstIdx>:<lastIdx>`) OR each
 *       live tool/tool_result row (key = `tc:<callId>:<role>`)
 *    3. Streaming thinking bubble if any (key = `STREAMING_THINKING_KEY`)
 *    4. Streaming text bubble if any   (key = `STREAMING_TEXT_KEY`)
 *
 *  @param {TranscriptState} state
 *  @param {Set<string>} [expandedItems]
 *  @param {{ rawAssistant?: boolean }} [opts]
 *  @returns {{ key: string, html: string }[]}
 */
export function renderTranscriptBlocks(state, expandedItems, opts) {
  const expanded = expandedItems ?? new Set();
  const renderOpts = opts ?? {};
  const blocks = [];
  const msgs = state.messages;

  let i = 0;
  while (i < msgs.length) {
    if (isToolRow(msgs[i])) {
      let j = i;
      while (j < msgs.length && isToolRow(msgs[j])) j++;
      const run = msgs.slice(i, j);
      const isLive = j === msgs.length;
      if (isLive) {
        run.forEach((m, k) => {
          blocks.push({
            key: messageKey(m, i + k),
            html: renderMessage(m, i + k, expanded, renderOpts),
          });
        });
      } else {
        const runKey = `run:${i}:${i + run.length - 1}`;
        blocks.push({
          key: runKey,
          html: renderToolRun(run, i, expanded, renderOpts),
        });
      }
      i = j;
    } else {
      blocks.push({
        key: messageKey(msgs[i], i),
        html: renderMessage(msgs[i], i, expanded, renderOpts),
      });
      i += 1;
    }
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
