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

  if (name === "write" || name === "edit") return null;
  return null;
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
