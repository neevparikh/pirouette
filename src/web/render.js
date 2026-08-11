// Rendering helpers for pirouette chat UI.
// ES module — imported by app.js and by tests.
//
// Pure functions have no DOM/global dependencies and are directly testable
// in Node. `renderMarkdown` uses `marked` + `DOMPurify` which may be provided
// either via CDN globals (in the browser) or via npm packages (in tests).

// --- markdown ---
//
// Configured to match pi-coding-agent's markdown semantics (see
// node_modules/@earendil-works/pi-tui/dist/components/markdown.js):
//   - Default marked options (NO `breaks: true`). Single newlines are
//     treated as whitespace within paragraphs, not hard breaks.
//   - A strict strikethrough tokenizer so `~~foo~~` requires no spaces
//     directly inside the delimiters.
//   - Explicit-language-only syntax highlighting (no auto-detection). This
//     matches pi's behavior and avoids hljs misidentifying prose as
//     LiveCodeServer / AppleScript / whatever.

// Regex lifted from pi-tui's StrictStrikethroughTokenizer.
const STRICT_STRIKETHROUGH_REGEX =
  /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

let markedConfigured = false;
function configureMarked() {
  if (markedConfigured) return;
  const marked = globalThis.marked;
  if (!marked) return;

  try {
    if (marked.Tokenizer) {
      class StrictStrikethroughTokenizer extends marked.Tokenizer {
        del(src) {
          const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
          if (!match) return undefined;
          const text = match[2];
          return { type: "del", raw: match[0], text, tokens: this.lexer.inlineTokens(text) };
        }
      }
      marked.setOptions({ tokenizer: new StrictStrikethroughTokenizer() });
    }
  } catch {
    /* fall back to default tokenizer */
  }

  // Wire up syntax highlighting via marked-highlight + highlight.js.
  // If either library is missing (e.g. in the Vitest environment) we just
  // skip — marked will render plain <pre><code>.
  const markedHighlight =
    globalThis.markedHighlight && globalThis.markedHighlight.markedHighlight;
  const hljs = globalThis.hljs;
  if (markedHighlight && hljs) {
    marked.use(
      markedHighlight({
        langPrefix: "hljs language-",
        highlight(code, lang) {
          // Only highlight when an explicit language is given AND hljs
          // knows it. Auto-detection is unreliable (matches pi's
          // cli-highlight behavior).
          if (!lang || !hljs.getLanguage(lang)) return code;
          try {
            return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          } catch {
            return code;
          }
        },
      }),
    );
  }

  markedConfigured = true;
}

// File extensions we'll render inline as thumbnails when referenced
// (either via markdown `<img>` or a bare `<code>foo.png</code>`).
const INLINE_IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
]);

/** Decide whether a string looks like an in-tree file reference to an
 *  image we can serve. Used by both the `<img>` src rewriter and the
 *  `<code>` thumbnail-injector.
 *
 *  Conservative on purpose -- false positives turn unrelated text into
 *  broken `<img>` 404s on the page.
 *
 *  Accepts: relative paths like `plots/foo.png`, `./foo.png`, or just
 *  `foo.png`. Rejects: absolute paths, URLs (anything with `://`),
 *  data: URIs, paths with spaces or quotes (caller hasn't HTML-encoded
 *  them, so almost certainly not a real path), and anything not ending
 *  in a whitelisted image extension.
 */
export function looksLikeImagePathRef(s) {
  if (typeof s !== "string") return false;
  if (s.length === 0 || s.length > 512) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false; // URLs / data: / file:
  if (s.startsWith("/")) return false; // absolute -- not our worktree
  if (s.startsWith("#")) return false; // anchor
  if (/[\s"'<>`]/.test(s)) return false; // quotes/whitespace = prose, not a path
  // Must look like path/segment(s)/name.ext with a known image ext.
  const m = s.match(/(\.[a-zA-Z0-9]+)$/);
  if (!m) return false;
  return INLINE_IMAGE_EXTS.has(m[1].toLowerCase());
}

/** Best-effort: enhance a chunk of sanitized markdown HTML so that
 *  image paths the agent referenced inline actually render as
 *  thumbnails in the dashboard.
 *
 *  Returns `{ html, thumbnails }`:
 *    - `html`: the original input with `<img src="relative.png">`
 *      rewritten to use the `/api/agents/<id>/file?path=...` endpoint.
 *      Other content (inline-code spans, etc.) is untouched.
 *    - `thumbnails`: a separate HTML strip (`<div class="pi-image-strip">
 *      ...</div>`) containing one clickable thumbnail per unique
 *      image-path referenced via inline code in the message. Empty
 *      string if no paths were found. The caller renders this BELOW
 *      the markdown block (NOT inside it) so the thumbnails don't
 *      disrupt `<pre class="pi-md">`'s `white-space: pre` column
 *      alignment.
 *
 *  Detected paths come from two source spans:
 *    a) `<span class="pi-code">path.png</span>` -- pi-md output
 *    b) `<code>path.png</code>` with no `hljs` class -- legacy
 *       marked output from the `.md` fallback path
 *  Code blocks (`<pre><code class="hljs">...`) are skipped to avoid
 *  thumbnail-flooding when the agent lists many paths in a snippet.
 *
 *  `agentId` is required; if missing, we return the input unchanged
 *  with `thumbnails: ""`.
 */
export function enhanceImagePaths(html, agentId) {
  if (!html || !agentId) return { html, thumbnails: "" };

  let out = html;

  // 1. Rewrite <img src="..."> for relative paths. DOMPurify
  //    normalises to double-quoted attributes, so we only handle
  //    that form. This matters when the assistant emits raw HTML in
  //    markdown -- pi-md doesn't emit <img> tags itself, but the
  //    legacy `.md` fallback path (when no widthCols is supplied)
  //    does.
  out = out.replace(/<img\s+([^>]*?)src="([^"]*)"([^>]*?)>/gi, (match, before, src, after) => {
    if (!looksLikeImagePathRef(src)) return match;
    const newSrc = `/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(src)}`;
    const hasClass = /\sclass="/i.test(before) || /\sclass="/i.test(after);
    const classAttr = hasClass
      ? ""
      : ' class="max-h-64 rounded border border-base16-300 my-2"';
    const hasLoading = /\sloading="/i.test(before) || /\sloading="/i.test(after);
    const loadingAttr = hasLoading ? "" : ' loading="lazy"';
    return `<img ${before}src="${newSrc}"${after}${classAttr}${loadingAttr}>`;
  });

  // 2. Collect image paths referenced in inline-code spans. Two
  //    sources:
  //    a) <span class="pi-code">path.png</span> -- pi-md output
  //    b) <code>path.png</code> (no hljs class) -- legacy marked
  //       output from the .md fallback path
  //
  //    We deliberately skip <pre><code class="hljs">...</code></pre>
  //    (the hljs class is the giveaway) because code blocks often
  //    contain dozens of paths in a snippet, and we don't want to
  //    flood the view.
  //
  //    Thumbnails are NOT inserted inline -- they're returned in
  //    a separate string the caller renders BELOW the markdown
  //    block. Inline insertion would break `<pre class="pi-md">`'s
  //    `white-space: pre` rhythm (an `<img>` is taller than a line
  //    of text and would push subsequent lines out of alignment).
  const seen = new Set();
  const paths = [];
  const collect = (decoded) => {
    if (!looksLikeImagePathRef(decoded)) return;
    if (seen.has(decoded)) return;
    seen.add(decoded);
    paths.push(decoded);
  };
  const decode = (inner) =>
    inner
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  // pi-md inline code: <span class="pi-code">...</span> (the
  //   classes attribute may include additional pi-* classes for
  //   nested formatting, e.g. "pi-strong pi-code")
  for (const m of out.matchAll(/<span\s+class="[^"]*\bpi-code\b[^"]*">([^<]+)<\/span>/gi)) {
    collect(decode(m[1]));
  }
  // legacy marked: <code>...</code> not inside <pre><code class="hljs">
  for (const m of out.matchAll(/<code(?![^>]*\bclass="hljs)>([^<]+)<\/code>/gi)) {
    collect(decode(m[1]));
  }

  let thumbnails = "";
  if (paths.length > 0) {
    // `onerror` hides paths that 404 (the assistant proposed but
    // didn't create the file) so we don't leave broken-image icons.
    const cells = paths.map((p) => {
      const src = `/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(p)}`;
      return `<a href="${src}" target="_blank" rel="noopener" class="block" title="${p}"><img src="${src}" alt="${p}" loading="lazy" class="max-h-32 rounded border border-base16-300" onerror="this.parentNode.style.display='none'" /></a>`;
    }).join("");
    thumbnails = `<div class="pi-image-strip flex flex-wrap gap-2 mt-2">${cells}</div>`;
  }

  return { html: out, thumbnails };
}

/**
 * Render markdown to sanitized HTML.
 * Falls back to plain escaped text if marked/DOMPurify aren't available.
 */
export function renderMarkdown(text) {
  if (!text) return "";
  configureMarked();
  const marked = globalThis.marked;
  const DOMPurify = globalThis.DOMPurify;
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return escHtml(text);
  }
  try {
    const html = marked.parse(text);
    // Keep the `class="hljs language-..."` attributes so our CSS can color
    // syntax tokens. Default DOMPurify config already allows `class`.
    return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
  } catch {
    return escHtml(text);
  }
}

// --- html escaping ---

/** HTML-escape a string. Pure, no DOM dependency. */
export function escHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- path helpers ---

/** Shorten a long absolute path for display. */
export function shortenPath(p) {
  if (!p) return "";
  const home = "/Users/";
  const workdirPrefix = "/.pirouette/data/worktrees/";

  // Worktree prefix: strip everything up to and including the agent name.
  const wtIdx = p.indexOf(workdirPrefix);
  if (wtIdx !== -1) {
    const rest = p.slice(wtIdx + workdirPrefix.length);
    const slash = rest.indexOf("/");
    if (slash !== -1) return rest.slice(slash + 1);
    // If this IS the agent's root workdir, show it as worktrees/<name>.
    return `worktrees/${rest}`;
  }

  // Home directory: /Users/foo/bar → ~/bar
  if (p.startsWith(home)) {
    const parts = p.split("/");
    return "~/" + parts.slice(3).join("/");
  }
  return p;
}

// --- tool parsing ---

export function parseToolArgs(args) {
  if (!args) return null;
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return { _raw: args };
    }
  }
  if (typeof args === "object") return args;
  return null;
}

/**
 * Given a tool name and parsed args, return a display object.
 * { header, subtitle, body, bodyIsRich }
 */
export function describeToolCall(toolName, args) {
  const parsed = parseToolArgs(args);
  const name = (toolName || "").toLowerCase();

  if (!parsed) {
    return { header: toolName || "tool", subtitle: "", body: "", bodyIsRich: false };
  }

  if (name === "bash") {
    const cmd = parsed.command || "";
    const desc = parsed.description || "";
    const oneLine = !cmd.includes("\n") && cmd.length <= 100;
    return {
      header: desc || "bash",
      subtitle: oneLine
        ? cmd
        : cmd.split("\n")[0].slice(0, 80) + (cmd.length > 80 ? "…" : ""),
      body: oneLine ? "" : cmd,
      bodyIsRich: false,
    };
  }

  if (name === "read") {
    const p = parsed.file_path || parsed.path || "";
    let subtitle = shortenPath(p);
    const extras = [];
    if (parsed.offset) extras.push(`from line ${parsed.offset}`);
    if (parsed.limit) extras.push(`${parsed.limit} lines`);
    if (extras.length) subtitle += ` (${extras.join(", ")})`;
    return { header: "read", subtitle, body: "", bodyIsRich: false };
  }

  if (name === "edit") {
    const p = parsed.file_path || parsed.path || "";
    const oldStr = parsed.old_string || parsed.oldText || "";
    const newStr = parsed.new_string || parsed.newText || "";
    return {
      header: "edit",
      subtitle: shortenPath(p),
      body: renderDiff(oldStr, newStr),
      bodyIsRich: true,
    };
  }

  if (name === "write") {
    const p = parsed.file_path || parsed.path || "";
    const content = parsed.content || "";
    const lines = content.split("\n");
    const preview = lines.slice(0, 10).join("\n");
    const body =
      lines.length > 10 ? `${preview}\n… (${lines.length} lines total)` : preview;
    return {
      header: "write",
      subtitle: `${shortenPath(p)} (${lines.length} lines)`,
      body,
      bodyIsRich: false,
    };
  }

  // Todo lists (pi-manage-todo-list and friends). The raw args are a
  // wall of JSON — every item carries a multi-line `description` the
  // model wrote for itself — so we render the checklist instead, the
  // same shape the extension draws in the terminal.
  if (name === "manage_todo_list" || name === "todo_write" || name === "todowrite") {
    const op = typeof parsed.operation === "string" ? parsed.operation : "write";
    const todos = normalizeTodos(parsed.todoList ?? parsed.todos);
    if (op === "read" || todos.length === 0) {
      return { header: "todos", subtitle: op, body: "", bodyIsRich: false };
    }
    return {
      header: "todos",
      subtitle: todoProgress(todos),
      body: renderTodoList(todos),
      bodyIsRich: true,
    };
  }

  if (name === "grep" || name === "find" || name === "glob") {
    const pattern = parsed.pattern || parsed.query || "";
    const pathPart = parsed.path ? ` in ${shortenPath(parsed.path)}` : "";
    const extras = [];
    if (parsed.glob) extras.push(parsed.glob);
    if (parsed.type) extras.push(parsed.type);
    const subtitle =
      pattern + pathPart + (extras.length ? ` (${extras.join(", ")})` : "");
    return { header: name, subtitle, body: "", bodyIsRich: false };
  }

  if (name === "ls") {
    return {
      header: "ls",
      subtitle: shortenPath(parsed.path || parsed.dir || "."),
      body: "",
      bodyIsRich: false,
    };
  }

  // Generic tool — pretty-print args
  const body = Object.keys(parsed).length > 0 ? JSON.stringify(parsed, null, 2) : "";
  return { header: toolName || "tool", subtitle: "", body, bodyIsRich: false };
}

/**
 * Summarize a tool result. Returns null if no good summary.
 * e.g. "12 matches", "523 lines"
 */
export function describeToolResult(toolName, content, isError) {
  if (isError) return null;
  const name = (toolName || "").toLowerCase();
  const text = typeof content === "string" ? content : String(content ?? "");
  if (!text.trim()) return null;

  if (name === "read") {
    const lines = text.split("\n").length;
    return `${lines} line${lines === 1 ? "" : "s"}`;
  }

  if (name === "grep" || name === "find" || name === "glob") {
    const lines = text.split("\n").filter((l) => l.trim()).length;
    if (/no\s*(matches|files)/i.test(text)) return "no matches";
    return `${lines} match${lines === 1 ? "" : "es"}`;
  }

  if (name === "ls") {
    const entries = text.split("\n").filter((l) => l.trim()).length;
    return `${entries} ${entries === 1 ? "entry" : "entries"}`;
  }

  if (name === "bash") {
    const lines = text.split("\n").length;
    return lines > 3 ? `${lines} lines of output` : null;
  }

  if (BODYLESS_RESULT_TOOLS.has(name)) {
    // The tool answers with a paragraph aimed at the model; the only
    // part worth showing is the progress count buried in it.
    const m = text.match(/(\d+)\s*\/\s*(\d+)\s+completed/i);
    return m ? `${m[1]}/${m[2]} completed` : null;
  }

  if (name === "write" || name === "edit") return null;
  return null;
}

/** Tools whose result text is boilerplate the call itself already shows.
 *  The transcript renders the tool name + summary and drops the body.
 *  (`manage_todo_list` answers every write with a paragraph of
 *  instructions addressed to the model, not to the reader.) */
const BODYLESS_RESULT_TOOLS = new Set(["manage_todo_list", "todo_write", "todowrite"]);

/** Should the transcript suppress this tool result's body? */
export function hidesToolResultBody(toolName, isError) {
  if (isError) return false;
  return BODYLESS_RESULT_TOOLS.has((toolName || "").toLowerCase());
}

// --- todo lists ---

const TODO_ICONS = {
  completed: "\u2713",
  "in-progress": "\u25c9",
  "not-started": "\u25cb",
};

/** Icon + title colors per status. Completed items are struck through and
 *  dimmed, in-progress is the one thing you want to spot at a glance. */
const TODO_CLASSES = {
  completed: { icon: "text-base16-green", title: "text-base16-500 line-through" },
  "in-progress": { icon: "text-base16-yellow", title: "text-base16-yellow" },
  "not-started": { icon: "text-base16-500", title: "text-base16-600" },
};

/** Coerce whatever the tool was called with into a list of todo items,
 *  dropping anything that doesn't look like one. */
export function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const status = TODO_ICONS[item.status] ? item.status : "not-started";
    out.push({
      id: item.id,
      title: typeof item.title === "string" ? item.title : "",
      status,
    });
  }
  return out;
}

/** "3/7 completed", or "all 7 done" when the list is finished. */
export function todoProgress(todos) {
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  if (total > 0 && done === total) return `all ${total} done`;
  return `${done}/${total} completed`;
}

/** Render a todo list as an HTML checklist (rich body). */
export function renderTodoList(todos) {
  let html = '<div class="font-mono text-[11px] leading-5">';
  for (const todo of todos) {
    const cls = TODO_CLASSES[todo.status];
    const icon = TODO_ICONS[todo.status];
    const label = todo.id === undefined || todo.id === null ? "" : `${todo.id}. `;
    html += `<div><span class="${cls.icon}">${icon}</span> <span class="${cls.title}">${escHtml(label + todo.title)}</span></div>`;
  }
  html += "</div>";
  return html;
}

// --- diff rendering ---

/** Render a simple line-level diff between old and new strings. */
export function renderDiff(oldStr, newStr) {
  const oldLines = (oldStr || "").split("\n");
  const newLines = (newStr || "").split("\n");

  let html = '<div class="font-mono text-[11px] leading-5">';
  for (const line of oldLines) {
    html += `<span class="diff-line diff-del">- ${escHtml(line) || "&nbsp;"}</span>`;
  }
  for (const line of newLines) {
    html += `<span class="diff-line diff-add">+ ${escHtml(line) || "&nbsp;"}</span>`;
  }
  html += "</div>";
  return html;
}

// --- relative time ---

/** Human-readable relative time from a past timestamp (ms since epoch).
 *  Pass an optional `now` for deterministic testing. */
export function relTime(ms, now) {
  const nowMs = now ?? Date.now();
  const s = Math.floor((nowMs - ms) / 1000);
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// --- fast-mode badge ---

/** Bare model id: provider prefix stripped, lowercased.
 *
 *  Fast-mode providers report their own local id (`claude-opus-5`) while
 *  agent configs and pi's live stats are provider-qualified
 *  (`hawk/claude-opus-5`), so both sides get folded to the same key. Must
 *  stay in lockstep with `normalizeFastModeModelId` in
 *  src/server/fast-mode.ts, which is what keys the snapshot we're reading.
 *  Returns null for anything unusable. */
export function normalizeModelId(model) {
  if (typeof model !== "string") return null;
  const bare = model.trim().split("/").pop();
  if (!bare) return null;
  return bare.toLowerCase() || null;
}

/** Pick the fast-mode state that applies to `model` out of the server's
 *  snapshot.
 *
 *  Per-model readings win; the provider-wide toggle (`global`) is the
 *  fallback for a model that hasn't run a turn yet, so `/fast on` lights the
 *  "requested, awaiting next turn" badge immediately. Returns null when
 *  nothing applies (badge hidden).
 *
 *  This lookup is the whole point of the per-model split: without it the
 *  badge shows whichever model the shared provider served last, which in a
 *  multi-agent server (or with auto-mode's per-tool-call classifier running
 *  on a non-fast model) is usually not the agent you're looking at. */
export function pickFastModeState(snapshot, model) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const key = normalizeModelId(model);
  const byModel = snapshot.byModel;
  if (key && byModel && Object.prototype.hasOwnProperty.call(byModel, key)) {
    return byModel[key] ?? null;
  }
  return snapshot.global ?? null;
}

/** Build the browser tab title: `pirouette—<project>—<chat>`.
 *
 *  Both trailing segments are optional and dropped when unknown, so the
 *  title degrades to `pirouette—<project>` (a project picked in the
 *  sidebar but no chat open) and finally to plain `pirouette`. */
export function formatDocumentTitle(projectName, agentName) {
  const parts = ["pirouette"];
  const project = typeof projectName === "string" ? projectName.trim() : "";
  const agent = typeof agentName === "string" ? agentName.trim() : "";
  if (project) parts.push(project);
  if (project && agent) parts.push(agent);
  return parts.join("\u2014");
}

// --- transcript scrolling ---

/** How close to the bottom (px) still counts as "pinned to the bottom".
 *  Sub-pixel scroll heights and a half-rendered last line mean the exact
 *  arithmetic is rarely 0, so we need some slack. */
export const STICK_TO_BOTTOM_SLACK = 40;

/** Should the transcript be scrolled to the bottom after this render?
 *
 *  Two ways to say yes:
 *    - `pinned`: the caller knows the view should start at the bottom
 *      regardless of where the scrollbar happens to sit. That's the case
 *      right after an agent switch, where the container's `scrollTop` is
 *      still a leftover from the *previous* chat and says nothing about
 *      where the user wants to be in this one.
 *    - the user was already parked within `slack` px of the bottom, so
 *      they're following along and want to keep following.
 *
 *  Otherwise they scrolled up to read history: leave the view alone. */
export function shouldStickToBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
  pinned = false,
  slack = STICK_TO_BOTTOM_SLACK,
}) {
  if (pinned) return true;
  return scrollHeight - scrollTop - clientHeight < slack;
}

// --- sidebar width ---

/** Narrowest useful sidebar: below this the chat rows stop being readable
 *  at all and the header's "+ project" button starts clipping. */
export const SIDEBAR_MIN_WIDTH = 176;
/** Tailwind's `w-64` — what the markup ships with, and what a
 *  double-click on the drag handle goes back to. */
export const SIDEBAR_DEFAULT_WIDTH = 256;
/** Widest sidebar we'll allow on a very large screen. */
export const SIDEBAR_MAX_WIDTH = 640;

/** Clamp a requested sidebar width (px) to something the current viewport
 *  can actually show.
 *
 *  The upper bound is the smaller of `SIDEBAR_MAX_WIDTH` and half the
 *  viewport, so a width dragged out on a wide monitor doesn't swallow the
 *  chat column on a laptop later — but it's never allowed below the
 *  minimum, so even an absurdly narrow window keeps a usable sidebar
 *  rather than collapsing it to nothing. Junk input (NaN, a corrupted
 *  localStorage value) falls back to the default. */
export function clampSidebarWidth(width, viewportWidth) {
  const n = typeof width === "number" ? width : Number.parseInt(width, 10);
  const requested = Number.isFinite(n) ? n : SIDEBAR_DEFAULT_WIDTH;
  const half = Number.isFinite(viewportWidth) ? Math.round(viewportWidth / 2) : SIDEBAR_MAX_WIDTH;
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, half));
  return Math.round(Math.min(Math.max(requested, SIDEBAR_MIN_WIDTH), max));
}
