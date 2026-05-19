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
