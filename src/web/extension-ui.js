// Extension UI surfaces: toasts (`extension_ui_notify`), the per-agent
// status strip (`extension_ui_status`), and pinned widgets
// (`extension_ui_widget`).
//
// Both envelopes come from the server's ExtensionUIContext (see
// src/server/pirouette-ui-context.ts), which is the bridge for a pi
// extension calling `ctx.ui.notify(message, type)` / `ctx.ui.setStatus(key,
// text)`. The TUI shows these inline; the dashboard needs its own slots.
//
// Design notes:
//
//   - Toasts live in a fixed stack at the TOP-right of the chat column,
//     never the bottom: the composer, the slash/mention popups and the
//     queue strip all live at the bottom, and a burst of notifications
//     covering the thing you type into is how a toast system becomes a
//     trap. At most `maxVisible` are on screen at once; the rest wait
//     their turn in the same per-agent queue.
//
//   - Notifications are per agent. Anything for an agent you're not
//     looking at is queued rather than shown (a toast with no visible
//     context is noise), capped at `queueLimit` newest entries, and
//     dropped if it goes stale before you switch over — a status report
//     from ten minutes ago is not worth interrupting for. `pendingFor()`
//     lets the chat list mark that something is waiting.
//
//   - Widgets are the one persistent surface: an extension calls
//     `ctx.ui.setWidget(key, …)` and the content stays on screen until it
//     sets the key again or clears it (a todo list's progress checklist,
//     say). They sit in strips hugging the composer, above or below per
//     the extension's `placement`, and their text carries pi's *semantic*
//     colour names (`accent`, `success`, `dim`) rather than RGB — see
//     server/widget-render.ts — so a widget themes with everything else.
//
//   - Content can be big: an extension reporting its configuration emits
//     tens of lines of pretty-printed JSON, and one truncated line of that
//     is useless. Multi-line/long messages render collapsed to their first
//     line with a "+N more lines" toggle; expanding shows the whole thing
//     in a scrollable <pre> and pins the toast (no auto-dismiss) so it
//     can be read at leisure.
//
// Everything is plain DOM + Tailwind base16 utility classes so it themes
// with the rest of the dashboard. Message text is always written via
// textContent — extensions are not a trusted source of HTML.

/** Visible toasts at once. Beyond this, wait for a slot. */
export const TOAST_MAX_VISIBLE = 3;
/** Per-agent queue cap. Oldest entries fall off first. */
export const TOAST_QUEUE_LIMIT = 8;
/** A queued toast for a background agent is dropped rather than shown if
 *  the user only switches to that agent this long after it arrived. */
export const TOAST_STALE_MS = 3 * 60_000;
/** Auto-dismiss base, per severity. A per-character bonus (capped) is
 *  added on top so a longer message stays up long enough to read. */
export const TOAST_BASE_MS = { info: 6_000, warn: 10_000, error: 14_000 };
const TOAST_PER_CHAR_MS = 20;
const TOAST_LENGTH_BONUS_CAP_MS = 6_000;
/** Beyond this many characters (or any newline) a message is treated as
 *  "long": collapsed with an expand toggle instead of shown inline. */
const LONG_MESSAGE_CHARS = 160;

/** Per-severity theming. Only base16 variables — no literal colours — so
 *  every shipped theme gets sensible toasts. */
const TYPE_STYLE = {
  info: { accent: "text-base16-blue", border: "border-base16-blue/40", label: "info" },
  warn: { accent: "text-base16-yellow", border: "border-base16-yellow/50", label: "warn" },
  error: { accent: "text-base16-red", border: "border-base16-red/60", label: "error" },
};

/** Severity ordering, used to colour the "notifications waiting" dot with
 *  the worst thing in the queue. */
const SEVERITY_RANK = { info: 0, warn: 1, error: 2 };

/** pi theme colour name -> base16 class, for widget spans. Names the map
 *  doesn't know inherit the surrounding colour, which is a duller widget
 *  rather than a broken one. */
export const WIDGET_FG_CLASS = {
  accent: "text-base16-cyan",
  border: "text-base16-300",
  borderAccent: "text-base16-cyan",
  borderMuted: "text-base16-300",
  success: "text-base16-green",
  error: "text-base16-red",
  warning: "text-base16-yellow",
  muted: "text-base16-500",
  dim: "text-base16-400",
  text: "text-base16-700",
  thinkingText: "text-base16-purple",
  userMessageText: "text-base16-600",
  customMessageText: "text-base16-600",
  customMessageLabel: "text-base16-purple",
  toolTitle: "text-base16-cyan",
  toolOutput: "text-base16-500",
  mdHeading: "text-base16-blue",
  mdLink: "text-base16-blue",
  mdLinkUrl: "text-base16-500",
  mdCode: "text-base16-orange",
  mdCodeBlock: "text-base16-orange",
  mdQuote: "text-base16-500",
  mdListBullet: "text-base16-purple",
  toolDiffAdded: "text-base16-green",
  toolDiffRemoved: "text-base16-red",
  toolDiffContext: "text-base16-500",
  syntaxComment: "text-base16-500",
  syntaxKeyword: "text-base16-purple",
  syntaxString: "text-base16-green",
  syntaxNumber: "text-base16-orange",
  bashMode: "text-base16-pink",
};

export const WIDGET_BG_CLASS = {
  selectedBg: "bg-base16-300/40",
  userMessageBg: "bg-base16-200",
  customMessageBg: "bg-base16-200",
  toolPendingBg: "bg-base16-200",
  toolSuccessBg: "bg-base16-green/10",
  toolErrorBg: "bg-base16-red/10",
};

/** Map an extension's notify type onto our three buckets. pi's TUI accepts
 *  "info" | "warning" | "error"; extensions in the wild also pass "warn",
 *  "success", or nothing at all. Anything unrecognised is info. */
export function normalizeNotifyType(type) {
  const t = String(type ?? "").toLowerCase();
  if (t === "error" || t === "fatal") return "error";
  if (t === "warn" || t === "warning") return "warn";
  return "info";
}

/** Split a notification into a one-line summary and the remainder.
 *  @returns {{head: string, rest: string, extraLines: number, long: boolean}} */
export function splitMessage(message) {
  const text = String(message ?? "");
  const lines = text.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  const headIdx = firstIdx === -1 ? 0 : firstIdx;
  const head = (lines[headIdx] ?? "").trim();
  const rest = lines.slice(headIdx + 1).join("\n");
  const extraLines = rest.trim() === "" ? 0 : rest.split("\n").length;
  const long = extraLines > 0 || text.length > LONG_MESSAGE_CHARS;
  return { head, rest, extraLines, long };
}

/** How long a toast of this severity and size stays up. */
export function toastDurationMs(type, message) {
  const base = TOAST_BASE_MS[type] ?? TOAST_BASE_MS.info;
  const bonus = Math.min(String(message ?? "").length * TOAST_PER_CHAR_MS, TOAST_LENGTH_BONUS_CAP_MS);
  return base + bonus;
}

let nextToastId = 1;

/**
 * Owns both extension UI surfaces for the dashboard.
 *
 * The host (app.js) hands over two container elements plus a couple of
 * lookups, then forwards WS envelopes and selection changes. Kept free of
 * app.js globals so it can be driven directly from a DOM test.
 */
export class ExtensionUISurface {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.toastHost   container for the toast stack
   * @param {HTMLElement} opts.statusHost  container for the status pills
   * @param {(agentId: string) => string} [opts.agentLabel] human name for an agent
   * @param {number} [opts.maxVisible]
   * @param {number} [opts.queueLimit]
   * @param {number} [opts.staleMs]
   * @param {() => number} [opts.now]
   */
  constructor({
    toastHost,
    statusHost,
    widgetHost,
    widgetHostBelow,
    agentLabel = (id) => id,
    maxVisible = TOAST_MAX_VISIBLE,
    queueLimit = TOAST_QUEUE_LIMIT,
    staleMs = TOAST_STALE_MS,
    now = () => Date.now(),
  }) {
    this.toastHost = toastHost;
    this.statusHost = statusHost;
    this.widgetHost = widgetHost;
    this.widgetHostBelow = widgetHostBelow;
    this.agentLabel = agentLabel;
    this.maxVisible = maxVisible;
    this.queueLimit = queueLimit;
    this.staleMs = staleMs;
    this.now = now;
    /** Agent currently on screen; only its toasts are shown. */
    this.selectedAgentId = null;
    /** @type {Map<string, Array<{id:number, agentId:string, type:string, message:string, at:number}>>} */
    this.queues = new Map();
    /** @type {Array<{entry: object, el: HTMLElement, timer: any, pinned: boolean}>} */
    this.visible = [];
    /** @type {Map<string, Map<string, string>>} agentId -> key -> text */
    this.statuses = new Map();
    /** @type {Map<string, Map<string, object>>} agentId -> key -> widget */
    this.widgets = new Map();
    /** Called after anything that changes `pendingFor()`, so the host can
     *  repaint its chat list. */
    this.onPendingChange = null;
  }

  // --- envelope entry point -------------------------------------------

  /** Handle one WS envelope. Returns true if it was one of ours. */
  handleEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object") return false;
    if (envelope.kind === "extension_ui_notify") {
      this.notify(envelope.agentId, envelope.message, envelope.notifyType);
      return true;
    }
    if (envelope.kind === "extension_ui_status") {
      this.setStatus(envelope.agentId, envelope.statusKey, envelope.statusText);
      return true;
    }
    if (envelope.kind === "extension_ui_widget") {
      this.setWidget(envelope.agentId, envelope.widgetKey, envelope.widget);
      return true;
    }
    return false;
  }

  // --- toasts ----------------------------------------------------------

  notify(agentId, message, type) {
    const entry = {
      id: nextToastId++,
      agentId,
      type: normalizeNotifyType(type),
      message: String(message ?? ""),
      at: this.now(),
    };
    const queue = this.queues.get(agentId) ?? [];
    queue.push(entry);
    // Drop-oldest: a chatty extension can't push everything else out of
    // memory, and the newest report is the one worth reading.
    while (queue.length > this.queueLimit) queue.shift();
    this.queues.set(agentId, queue);
    this.pump();
    this.notifyPendingChange();
  }

  /** Move queued entries for the selected agent onto the screen, up to the
   *  visible cap. Stale entries are discarded on the way. */
  pump() {
    const agentId = this.selectedAgentId;
    if (!agentId) return;
    const queue = this.queues.get(agentId);
    if (!queue || queue.length === 0) return;
    const cutoff = this.now() - this.staleMs;
    while (queue.length > 0 && this.visible.length < this.maxVisible) {
      const entry = queue.shift();
      if (entry.at < cutoff) continue; // too old to be worth interrupting for
      this.showToast(entry);
    }
    // Drop anything already stale at the back of the queue, so a
    // background agent doesn't accumulate a pile of history.
    const fresh = queue.filter((e) => e.at >= cutoff);
    if (fresh.length === 0) this.queues.delete(agentId);
    else this.queues.set(agentId, fresh);
  }

  showToast(entry) {
    const doc = this.toastHost.ownerDocument;
    const style = TYPE_STYLE[entry.type] ?? TYPE_STYLE.info;
    const { head, rest, extraLines, long } = splitMessage(entry.message);

    const el = doc.createElement("div");
    el.className =
      `pointer-events-auto rounded-lg border shadow-lg bg-base16-200 ${style.border} ` +
      `px-3 py-2 flex items-start gap-2 text-left`;
    el.dataset.toastId = String(entry.id);
    el.dataset.toastType = entry.type;
    el.setAttribute("role", entry.type === "error" ? "alert" : "status");

    const badge = doc.createElement("span");
    badge.className = `text-[10px] font-mono flex-none mt-0.5 ${style.accent}`;
    badge.textContent = style.label;
    el.appendChild(badge);

    const body = doc.createElement("div");
    body.className = "min-w-0 flex-1";
    el.appendChild(body);

    const headEl = doc.createElement("div");
    headEl.className = "text-xs font-mono text-base16-700 break-words whitespace-pre-wrap";
    headEl.textContent = head || entry.message.trim() || "(empty notification)";
    body.appendChild(headEl);

    const record = { entry, el, timer: null, pinned: false };

    if (long) {
      // Collapsed by default: one line plus a toggle. Expanding pins the
      // toast so a wall of JSON doesn't vanish mid-read.
      const pre = doc.createElement("pre");
      pre.className =
        "hidden mt-1.5 max-h-[40vh] overflow-auto text-[11px] font-mono " +
        "text-base16-600 whitespace-pre bg-base16-100 rounded p-2";
      pre.textContent = entry.message;
      const toggle = doc.createElement("button");
      toggle.className =
        "mt-1 text-[10px] font-mono text-base16-500 hover:text-base16-cyan cursor-pointer";
      toggle.dataset.toastExpand = "1";
      toggle.textContent = extraLines > 0 ? `show all (+${extraLines} lines)` : "show all";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const expanded = pre.classList.toggle("hidden") === false;
        toggle.textContent = expanded
          ? "collapse"
          : extraLines > 0
            ? `show all (+${extraLines} lines)`
            : "show all";
        if (expanded) {
          record.pinned = true;
          this.clearTimer(record);
        } else {
          record.pinned = false;
          this.armTimer(record);
        }
      });
      body.appendChild(toggle);
      body.appendChild(pre);
    }

    const agentName = this.agentLabel(entry.agentId);
    if (agentName) {
      const who = doc.createElement("div");
      who.className = "mt-1 text-[10px] font-mono text-base16-500 truncate";
      who.textContent = agentName;
      body.appendChild(who);
    }

    const close = doc.createElement("button");
    close.className =
      "flex-none text-xs font-mono text-base16-500 hover:text-base16-red cursor-pointer px-1";
    close.dataset.toastClose = "1";
    close.setAttribute("aria-label", "dismiss notification");
    close.textContent = "✕";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.dismiss(entry.id);
    });
    el.appendChild(close);

    // Hovering pauses the countdown; leaving restarts it. Same courtesy
    // as every other toast system — you can't lose a message by reading it.
    el.addEventListener("mouseenter", () => this.clearTimer(record));
    el.addEventListener("mouseleave", () => this.armTimer(record));

    this.toastHost.appendChild(el);
    this.toastHost.classList.remove("hidden");
    this.visible.push(record);
    this.armTimer(record);
  }

  armTimer(record) {
    if (record.pinned || record.timer) return;
    const ms = toastDurationMs(record.entry.type, record.entry.message);
    record.timer = setTimeout(() => {
      record.timer = null;
      this.dismiss(record.entry.id);
    }, ms);
  }

  clearTimer(record) {
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
  }

  dismiss(toastId) {
    const idx = this.visible.findIndex((r) => r.entry.id === toastId);
    if (idx === -1) return;
    const [record] = this.visible.splice(idx, 1);
    this.clearTimer(record);
    record.el.remove();
    if (this.visible.length === 0) this.toastHost.classList.add("hidden");
    // A slot just freed up: let the next queued notification through.
    this.pump();
    this.notifyPendingChange();
  }

  /** Tear down every on-screen toast (they belong to the agent we're
   *  leaving). Undismissed ones go back to the head of that agent's queue
   *  so switching away and back doesn't silently eat them. */
  clearVisible({ requeue = true } = {}) {
    if (this.visible.length === 0) return;
    const returned = [];
    for (const record of this.visible) {
      this.clearTimer(record);
      record.el.remove();
      if (requeue) returned.push(record.entry);
    }
    this.visible = [];
    this.toastHost.classList.add("hidden");
    if (returned.length > 0) {
      const agentId = returned[0].agentId;
      const queue = this.queues.get(agentId) ?? [];
      queue.unshift(...returned);
      while (queue.length > this.queueLimit) queue.pop();
      this.queues.set(agentId, queue);
    }
  }

  /** What's waiting for an agent the user isn't looking at.
   *  @returns {{count: number, severity: "info"|"warn"|"error"} | null} */
  pendingFor(agentId) {
    const queue = this.queues.get(agentId);
    if (!queue || queue.length === 0) return null;
    const cutoff = this.now() - this.staleMs;
    const fresh = queue.filter((e) => e.at >= cutoff);
    if (fresh.length === 0) return null;
    let severity = "info";
    for (const e of fresh) {
      if (SEVERITY_RANK[e.type] > SEVERITY_RANK[severity]) severity = e.type;
    }
    return { count: fresh.length, severity };
  }

  notifyPendingChange() {
    if (typeof this.onPendingChange === "function") this.onPendingChange();
  }

  // --- status -----------------------------------------------------------

  /** `text === null` (or undefined/empty) clears the key. */
  setStatus(agentId, key, text) {
    if (!agentId || !key) return;
    const byKey = this.statuses.get(agentId) ?? new Map();
    if (text === null || text === undefined || String(text).trim() === "") {
      byKey.delete(key);
    } else {
      byKey.set(key, String(text));
    }
    if (byKey.size === 0) this.statuses.delete(agentId);
    else this.statuses.set(agentId, byKey);
    if (agentId === this.selectedAgentId) this.renderStatus();
  }

  /** Sorted `[key, text]` pairs for an agent — stable ordering so several
   *  extensions setting keys don't make the strip jitter. */
  statusEntries(agentId) {
    const byKey = this.statuses.get(agentId);
    if (!byKey) return [];
    return [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  renderStatus() {
    const host = this.statusHost;
    if (!host) return;
    const doc = host.ownerDocument;
    const entries = this.selectedAgentId ? this.statusEntries(this.selectedAgentId) : [];
    host.textContent = "";
    if (entries.length === 0) {
      host.classList.add("hidden");
      return;
    }
    host.classList.remove("hidden");
    for (const [key, text] of entries) {
      const pill = doc.createElement("span");
      // Quiet by design: this sits next to the chat name and several
      // extensions may set keys at once, so it reads as a label strip
      // rather than a row of buttons.
      pill.className =
        "text-[10px] font-mono px-1.5 py-0.5 rounded bg-base16-300/40 text-base16-500 " +
        "max-w-[14rem] truncate";
      pill.dataset.statusKey = key;
      pill.title = `${key}: ${text}`;
      pill.textContent = text;
      host.appendChild(pill);
    }
  }

  // --- widgets ----------------------------------------------------------

  /** `widget === null` clears the key. A widget arrives pre-rendered as
   *  lines of styled spans; we only place it. */
  setWidget(agentId, key, widget) {
    if (!agentId || !key) return;
    const byKey = this.widgets.get(agentId) ?? new Map();
    if (widget && Array.isArray(widget.lines) && widget.lines.length > 0) {
      byKey.set(key, widget);
    } else {
      byKey.delete(key);
    }
    if (byKey.size === 0) this.widgets.delete(agentId);
    else this.widgets.set(agentId, byKey);
    if (agentId === this.selectedAgentId) this.renderWidgets();
  }

  /** Widgets for an agent, sorted by key — stable ordering so several
   *  extensions setting widgets don't make the strip jump around. */
  widgetEntries(agentId) {
    const byKey = this.widgets.get(agentId);
    if (!byKey) return [];
    return [...byKey.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, widget]) => widget);
  }

  renderWidgets() {
    const widgets = this.selectedAgentId ? this.widgetEntries(this.selectedAgentId) : [];
    for (const [host, placement] of [
      [this.widgetHost, "aboveEditor"],
      [this.widgetHostBelow, "belowEditor"],
    ]) {
      if (!host) continue;
      const mine = widgets.filter((w) => (w.placement ?? "aboveEditor") === placement);
      host.textContent = "";
      host.classList.toggle("hidden", mine.length === 0);
      for (const widget of mine) host.appendChild(this.buildWidget(widget));
    }
  }

  /** One widget as a block of monospace lines. Text goes in via
   *  textContent — an extension is not a trusted source of HTML. */
  buildWidget(widget) {
    const doc = (this.widgetHost ?? this.widgetHostBelow).ownerDocument;
    const block = doc.createElement("div");
    block.className =
      "font-mono text-[11px] leading-5 whitespace-pre overflow-x-auto text-base16-600";
    block.dataset.widgetKey = String(widget.key ?? "");
    for (const line of widget.lines ?? []) {
      const lineEl = doc.createElement("div");
      const spans = Array.isArray(line) ? line : [];
      for (const span of spans) {
        const classes = [];
        const fg = WIDGET_FG_CLASS[span.color];
        if (fg) classes.push(fg);
        const bg = WIDGET_BG_CLASS[span.bg];
        if (bg) classes.push(bg);
        if (span.bold) classes.push("font-bold");
        if (span.italic) classes.push("italic");
        if (span.underline) classes.push("underline");
        if (span.strikethrough) classes.push("line-through");
        const el = doc.createElement("span");
        if (classes.length > 0) el.className = classes.join(" ");
        el.textContent = String(span.text ?? "");
        lineEl.appendChild(el);
      }
      // A blank line is spacing the widget asked for; keep it from
      // collapsing to zero height.
      if (lineEl.textContent === "") lineEl.textContent = "\u00a0";
      block.appendChild(lineEl);
    }
    return block;
  }

  // --- lifecycle --------------------------------------------------------

  /** Follow the chat selection: park the outgoing agent's toasts and show
   *  the incoming agent's status, widgets + queued notifications. */
  setSelectedAgent(agentId) {
    if (agentId === this.selectedAgentId) {
      this.renderStatus();
      this.renderWidgets();
      this.pump();
      return;
    }
    this.clearVisible();
    this.selectedAgentId = agentId ?? null;
    this.renderStatus();
    this.renderWidgets();
    this.pump();
    this.notifyPendingChange();
  }

  /** Agent deleted / session gone — drop everything we hold for it. */
  forgetAgent(agentId) {
    this.queues.delete(agentId);
    this.statuses.delete(agentId);
    this.widgets.delete(agentId);
    for (const record of [...this.visible]) {
      if (record.entry.agentId === agentId) this.dismiss(record.entry.id);
    }
    if (agentId === this.selectedAgentId) {
      this.renderStatus();
      this.renderWidgets();
    }
    this.notifyPendingChange();
  }
}
