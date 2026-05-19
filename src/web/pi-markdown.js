// Browser port of @earendil-works/pi-tui's Markdown component.
//
// Renders markdown into a single string of plain-text lines (separated
// by `\n`) with HTML `<span class="pi-*">` markers for inline styling.
// The whole thing is meant to be wrapped in a `<pre class="pi-md">` so
// the browser preserves leading whitespace, padding, and the
// box-drawing characters used for tables / blockquotes / horizontal
// rules.
//
// Why a port instead of CSS-styled marked HTML?
//   We want the *exact* pi-cli look: tables drawn with
//   `┌─┬─┐ / ├─┼─┤ / └─┴─┘`, blockquotes with a literal `│ ` prefix
//   on every wrapped line, headings prefixed with `### `, list bullets
//   aligned with leading spaces, horizontal rules as a row of `─`.
//   None of that comes "for free" from a flow-layout CSS renderer.
//
// Architecture:
//   - Marked tokenises the input.
//   - Block tokens (heading, paragraph, code, list, table, blockquote,
//     hr) are each turned into an array of "rendered lines".
//   - A "rendered line" is an array of `Run` objects: `{ text, classes,
//     href?, _isHtml? }`. We model styled text as arrays of runs so
//     wrapping can split at whitespace boundaries WITHOUT breaking
//     inside `<span>` tags -- the same trick pi-tui uses with ANSI
//     code tracking, adapted for HTML output.
//   - Width-aware wrapping: takes a width in monospace cells. Cells =
//     string length, with best-effort handling for surrogate pairs and
//     combining marks. NOT pixel-perfect (we don't have access to the
//     terminal-grade East Asian Width tables) but good enough for the
//     ASCII + emoji + ligature world the assistant lives in.
//   - Final step: each line is escaped + wrapped in its <span>s and
//     joined with `\n`. CSS `white-space: pre` on the wrapper does the
//     rest.

import { escHtml } from "./render.js";

// ---------- width helpers ----------

/** Visible width of a plain string in monospace cells.
 *
 *  - ASCII printable: 1 cell each.
 *  - Surrogate pairs: 1 cell (most emoji are actually 2 cells in a
 *    real terminal but that varies wildly by font and renderer;
 *    1 cell is the conservative default that doesn't OVERCOUNT
 *    and produce wrap-too-early).
 *  - Combining marks (rough ranges): 0 cells.
 *
 *  Does NOT understand ANSI / HTML / spans -- runs hold plain text
 *  only; HTML escaping happens at the very end.
 */
export function cellWidth(s) {
  if (!s) return 0;
  // Fast path: pure ASCII
  let allAscii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) {
      allAscii = false;
      break;
    }
  }
  if (allAscii) return s.length;
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    // Combining marks
    if (
      (cp >= 0x0300 && cp <= 0x036f) ||
      (cp >= 0x1ab0 && cp <= 0x1aff) ||
      (cp >= 0x1dc0 && cp <= 0x1dff) ||
      (cp >= 0x20d0 && cp <= 0x20ff) ||
      (cp >= 0xfe20 && cp <= 0xfe2f)
    )
      continue;
    w += 1;
  }
  return w;
}

function runsText(runs) {
  let s = "";
  for (const r of runs) s += r.text;
  return s;
}

function longestWordWidth(text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  let longest = 0;
  for (const w of words) longest = Math.max(longest, cellWidth(w));
  return maxWidth === undefined ? longest : Math.min(longest, maxWidth);
}

// ---------- wrap algorithm ----------

/** Wrap a runs-line at the given width.
 *
 *  Greedy fill: tokenize by whitespace runs, accumulate tokens until
 *  the next one would exceed `width`. Long single tokens (URLs, no-
 *  space code) are broken char-by-char.
 *
 *  Returns an array of runs-lines (each itself a Run[]). Always
 *  returns at least one line. Trailing whitespace on each line is
 *  trimmed; lines never start with whitespace.
 */
export function wrapRuns(runs, width) {
  if (!runs || runs.length === 0) return [[]];
  if (width <= 0) return [runs];

  // Tokenize each run by whitespace boundaries, carrying its classes
  // onto every token.
  const tokens = [];
  for (const run of runs) {
    if (run._isHtml) {
      // HTML runs are opaque -- treat as a single non-breakable token.
      // Width is 0 because we don't try to measure inside HTML; that's
      // OK because such runs only appear in code blocks which we don't
      // wrap.
      tokens.push({ ...run, isWs: false, width: 0 });
      continue;
    }
    let i = 0;
    while (i < run.text.length) {
      const isWs = /\s/.test(run.text[i]);
      let j = i + 1;
      while (j < run.text.length && /\s/.test(run.text[j]) === isWs) j++;
      const text = run.text.slice(i, j);
      tokens.push({
        text,
        classes: run.classes,
        href: run.href,
        isWs,
        width: cellWidth(text),
      });
      i = j;
    }
  }
  if (tokens.length === 0) return [[]];

  const out = [];
  let cur = [];
  let curW = 0;

  function flush() {
    // Trim trailing whitespace tokens
    while (cur.length > 0 && /^\s*$/.test(cur[cur.length - 1].text)) cur.pop();
    out.push(cur);
    cur = [];
    curW = 0;
  }

  for (const tok of tokens) {
    // Long unbreakable token -- char-by-char break
    if (tok.width > width && !tok.isWs) {
      if (cur.length > 0) flush();
      let chunk = "";
      let chunkW = 0;
      for (const ch of tok.text) {
        const cw = cellWidth(ch);
        if (chunkW + cw > width && chunkW > 0) {
          cur.push({ text: chunk, classes: tok.classes, href: tok.href });
          flush();
          chunk = "";
          chunkW = 0;
        }
        chunk += ch;
        chunkW += cw;
      }
      if (chunk) {
        cur.push({ text: chunk, classes: tok.classes, href: tok.href });
        curW = chunkW;
      }
      continue;
    }
    if (curW + tok.width > width && curW > 0) {
      flush();
      if (tok.isWs) continue; // don't start a new line with whitespace
    }
    cur.push({ text: tok.text, classes: tok.classes, href: tok.href });
    curW += tok.width;
  }
  if (cur.length > 0 || out.length === 0) flush();
  return out;
}

// ---------- inline tokens → runs ----------

function inlineToString(tokens) {
  let s = "";
  for (const t of tokens || []) {
    if (t.tokens && t.tokens.length) s += inlineToString(t.tokens);
    else if (typeof t.text === "string") s += t.text;
  }
  return s;
}

function withClasses(runs, extra) {
  if (!extra || extra.length === 0) return runs;
  return runs.map((r) => ({
    ...r,
    classes: extra.concat(r.classes || []),
  }));
}

/** Convert an array of marked inline tokens into runs. */
export function inlineToRuns(tokens, classes = []) {
  const out = [];
  for (const tok of tokens || []) {
    switch (tok.type) {
      case "text":
        if (tok.tokens && tok.tokens.length > 0) {
          out.push(...inlineToRuns(tok.tokens, classes));
        } else if (typeof tok.text === "string") {
          out.push({ text: tok.text, classes });
        }
        break;
      case "paragraph":
        out.push(...inlineToRuns(tok.tokens || [], classes));
        break;
      case "strong":
        out.push(...inlineToRuns(tok.tokens || [], classes.concat("pi-strong")));
        break;
      case "em":
        out.push(...inlineToRuns(tok.tokens || [], classes.concat("pi-em")));
        break;
      case "del":
        out.push(...inlineToRuns(tok.tokens || [], classes.concat("pi-del")));
        break;
      case "codespan":
        out.push({ text: tok.text, classes: classes.concat("pi-code") });
        break;
      case "link": {
        const innerText = inlineToString(tok.tokens || []) || tok.text || tok.href || "";
        const href = tok.href || "";
        // Match pi-tui semantics: if text differs from href, show
        // "text (href)". For mailto: strip the prefix when comparing.
        const hrefForCmp = href.startsWith("mailto:") ? href.slice(7) : href;
        const showUrlParens = href && innerText !== href && innerText !== hrefForCmp;
        out.push({ text: innerText, classes: classes.concat("pi-link"), href });
        if (showUrlParens) {
          out.push({
            text: ` (${href})`,
            classes: classes.concat("pi-link-url"),
          });
        }
        break;
      }
      case "br":
        out.push({ text: "\n", classes });
        break;
      case "image": {
        // We have no inline-image rendering in pi-md; emit a labelled
        // placeholder. The existing /api/agents/:id/file endpoint plus
        // enhanceImagePaths in render.js handles actual thumbnails
        // elsewhere. (TODO: post-process pi-md output to substitute
        // [image: foo.png] with thumbnails.)
        const alt = tok.text || tok.href || "image";
        const href = tok.href ? ` (${tok.href})` : "";
        out.push({
          text: `[image: ${alt}${href}]`,
          classes: classes.concat("pi-image-ref"),
        });
        break;
      }
      case "html":
        // Inline HTML: emit literally as plain text. Pi-tui does the
        // same -- it doesn't try to interpret embedded HTML.
        if (typeof tok.raw === "string") {
          out.push({ text: tok.raw, classes });
        }
        break;
      default:
        if (typeof tok.text === "string") {
          out.push({ text: tok.text, classes });
        }
    }
  }
  return out;
}

// ---------- runs → HTML ----------

function runsToHtml(runs) {
  let out = "";
  for (const run of runs) {
    if (!run.text) continue;
    const cls =
      run.classes && run.classes.length ? run.classes.join(" ") : "";
    if (run._isHtml) {
      // Text already contains HTML (e.g. hljs-highlighted code line).
      // Don't escape it. If a class is set, wrap in span; otherwise
      // emit raw.
      if (cls) out += `<span class="${cls}">${run.text}</span>`;
      else out += run.text;
    } else if (run.href) {
      const href = run.href.replace(/"/g, "&quot;").replace(/</g, "&lt;");
      const c = cls ? ` class="${cls}"` : "";
      out += `<a${c} href="${href}" target="_blank" rel="noopener">${escHtml(run.text)}</a>`;
    } else if (cls) {
      out += `<span class="${cls}">${escHtml(run.text)}</span>`;
    } else {
      out += escHtml(run.text);
    }
  }
  return out;
}

export function linesToHtml(lines) {
  return lines.map(runsToHtml).join("\n");
}

// ---------- syntax highlighting for code blocks ----------

function highlightCodeLines(text, lang) {
  const hljs = globalThis.hljs;
  if (!hljs || !lang || !hljs.getLanguage(lang)) {
    return { lines: text.split("\n"), isHtml: false };
  }
  try {
    const html = hljs.highlight(text, {
      language: lang,
      ignoreIllegals: true,
    }).value;
    return { lines: html.split("\n"), isHtml: true };
  } catch {
    return { lines: text.split("\n"), isHtml: false };
  }
}

// ---------- block renderers ----------

function renderHeading(token, width) {
  const level = Math.max(1, Math.min(6, token.depth || 1));
  const baseClasses = ["pi-heading", `pi-h${level}`];
  const inner = inlineToRuns(token.tokens || []);
  let runs;
  if (level >= 3) {
    const prefix = "#".repeat(level) + " ";
    runs = [
      { text: prefix, classes: baseClasses },
      ...withClasses(inner, baseClasses),
    ];
  } else {
    runs = withClasses(inner, baseClasses);
  }
  return wrapRuns(runs, width);
}

function renderParagraph(token, width) {
  const runs = inlineToRuns(token.tokens || []);
  return wrapRuns(runs, width);
}

function renderHr(width) {
  return [[{ text: "─".repeat(Math.min(width, 80)), classes: ["pi-hr"] }]];
}

function renderCode(token) {
  const lang = token.lang || "";
  const lines = [];
  lines.push([
    { text: "```" + lang, classes: ["pi-code-fence"] },
  ]);
  const { lines: codeLines, isHtml } = highlightCodeLines(token.text, lang);
  for (const codeLine of codeLines) {
    if (isHtml) {
      lines.push([
        { text: "  ", classes: ["pi-codeblock"] },
        { text: codeLine, classes: ["pi-codeblock"], _isHtml: true },
      ]);
    } else {
      lines.push([
        { text: "  " + codeLine, classes: ["pi-codeblock"] },
      ]);
    }
  }
  lines.push([
    { text: "```", classes: ["pi-code-fence"] },
  ]);
  return lines;
}

function renderList(token, depth, width) {
  const indentLen = depth * 2;
  const indentStr = " ".repeat(indentLen);
  const startNumber = token.start ?? 1;
  const out = [];
  for (let i = 0; i < token.items.length; i++) {
    const item = token.items[i];
    const bullet = token.ordered ? `${startNumber + i}. ` : "- ";
    const bulletWidth = bullet.length;
    const contentWidth = Math.max(1, width - indentLen - bulletWidth);
    const fullWidth = width;
    const itemLines = renderListItem(item.tokens || [], depth, contentWidth, fullWidth);
    if (itemLines.length === 0) {
      out.push([
        { text: indentStr, classes: [] },
        { text: bullet, classes: ["pi-list-bullet"] },
      ]);
      continue;
    }
    for (let j = 0; j < itemLines.length; j++) {
      const line = itemLines[j];
      if (line.isNested) {
        // Nested list lines already have their own indent baked in.
        out.push(line.runs);
        continue;
      }
      if (j === 0) {
        out.push([
          { text: indentStr, classes: [] },
          { text: bullet, classes: ["pi-list-bullet"] },
          ...line.runs,
        ]);
      } else {
        // Continuation lines: align under the bullet text, not under
        // the bullet itself. (e.g. "- foo bar" wrapped becomes
        //   "- foo\n  bar".)
        out.push([
          { text: indentStr + " ".repeat(bulletWidth), classes: [] },
          ...line.runs,
        ]);
      }
    }
  }
  return out;
}

function renderListItem(tokens, depth, contentWidth, fullWidth) {
  const out = [];
  for (const tok of tokens) {
    if (tok.type === "list") {
      const nested = renderList(tok, depth + 1, fullWidth);
      for (const ln of nested) out.push({ runs: ln, isNested: true });
    } else if (tok.type === "code") {
      const codeLines = renderCode(tok);
      for (const ln of codeLines) out.push({ runs: ln, isNested: false });
    } else if (tok.type === "text" || tok.type === "paragraph") {
      const innerTokens =
        tok.tokens && tok.tokens.length > 0
          ? tok.tokens
          : typeof tok.text === "string"
            ? [{ type: "text", text: tok.text }]
            : [];
      const inner = inlineToRuns(innerTokens);
      const wrapped = wrapRuns(inner, contentWidth);
      for (const ln of wrapped) out.push({ runs: ln, isNested: false });
    } else if (tok.type === "blockquote") {
      const lines = renderBlockquote(tok, contentWidth);
      for (const ln of lines) out.push({ runs: ln, isNested: false });
    } else {
      const inner = inlineToRuns([tok]);
      const wrapped = wrapRuns(inner, contentWidth);
      for (const ln of wrapped) {
        if (ln.length > 0) out.push({ runs: ln, isNested: false });
      }
    }
  }
  return out;
}

function renderBlockquote(token, width) {
  const innerWidth = Math.max(1, width - 2); // "│ "
  const innerLines = [];
  const quoteTokens = token.tokens || [];
  for (let i = 0; i < quoteTokens.length; i++) {
    const t = quoteTokens[i];
    const next = quoteTokens[i + 1];
    innerLines.push(...renderBlock(t, innerWidth, next?.type));
  }
  // Drop trailing empties so the outer block's spacing logic owns the
  // blank line after the quote.
  while (innerLines.length && innerLines[innerLines.length - 1].length === 0) {
    innerLines.pop();
  }
  const out = [];
  for (const ln of innerLines) {
    // Style all inner content as italic + muted, EXCEPT runs that
    // already have explicit classes (codeblock, table-border, etc.)
    // which should retain their original color.
    const inner = ln.map((r) => ({
      ...r,
      classes: ["pi-quote"].concat(r.classes || []),
    }));
    out.push([
      { text: "│ ", classes: ["pi-quote-bar"] },
      ...inner,
    ]);
  }
  return out;
}

function renderTable(token, availableWidth) {
  const out = [];
  const numCols = token.header.length;
  if (numCols === 0) return out;
  // Borders: "│ " + (n-1) * " │ " + " │"  = 3n + 1
  const borderOverhead = 3 * numCols + 1;
  const availableForCells = availableWidth - borderOverhead;
  if (availableForCells < numCols) {
    // Too narrow for stable rendering -- fall back to raw text.
    if (token.raw) {
      const wrapped = wrapRuns(
        [{ text: token.raw, classes: [] }],
        availableWidth,
      );
      out.push(...wrapped);
    }
    return out;
  }
  const maxUnbrokenWordWidth = 30;

  // --- column width calculation (ported from pi-tui) ---
  const natural = new Array(numCols).fill(0);
  const minWord = new Array(numCols).fill(0);
  for (let i = 0; i < numCols; i++) {
    const text = runsText(inlineToRuns(token.header[i].tokens || []));
    natural[i] = cellWidth(text);
    minWord[i] = Math.max(1, longestWordWidth(text, maxUnbrokenWordWidth));
  }
  for (const row of token.rows) {
    for (let i = 0; i < row.length; i++) {
      const text = runsText(inlineToRuns(row[i].tokens || []));
      natural[i] = Math.max(natural[i] || 0, cellWidth(text));
      minWord[i] = Math.max(
        minWord[i] || 1,
        longestWordWidth(text, maxUnbrokenWordWidth),
      );
    }
  }
  let minCols = minWord.slice();
  let minSum = minCols.reduce((a, b) => a + b, 0);
  if (minSum > availableForCells) {
    // Even the longest-word fits don't fit -- collapse to 1ch
    // minimums, then distribute proportionally to longest-word demand.
    minCols = new Array(numCols).fill(1);
    const remaining = availableForCells - numCols;
    if (remaining > 0) {
      const totalWeight = minWord.reduce(
        (t, w) => t + Math.max(0, w - 1),
        0,
      );
      const growth = minWord.map((w) => {
        const weight = Math.max(0, w - 1);
        return totalWeight > 0
          ? Math.floor((weight / totalWeight) * remaining)
          : 0;
      });
      for (let i = 0; i < numCols; i++) minCols[i] += growth[i] ?? 0;
      let leftover = remaining - growth.reduce((a, b) => a + b, 0);
      for (let i = 0; leftover > 0 && i < numCols; i++) {
        minCols[i]++;
        leftover--;
      }
    }
    minSum = minCols.reduce((a, b) => a + b, 0);
  }
  const totalNatural = natural.reduce((a, b) => a + b, 0) + borderOverhead;
  let cols;
  if (totalNatural <= availableWidth) {
    cols = natural.map((w, i) => Math.max(w, minCols[i]));
  } else {
    const totalGrowPotential = natural.reduce(
      (t, w, i) => t + Math.max(0, w - minCols[i]),
      0,
    );
    const extraWidth = Math.max(0, availableForCells - minSum);
    cols = minCols.map((minW, i) => {
      const grow =
        totalGrowPotential > 0
          ? Math.floor(
              (Math.max(0, natural[i] - minW) / totalGrowPotential) *
                extraWidth,
            )
          : 0;
      return minW + grow;
    });
    let remaining = availableForCells - cols.reduce((a, b) => a + b, 0);
    while (remaining > 0) {
      let grew = false;
      for (let i = 0; i < numCols && remaining > 0; i++) {
        if (cols[i] < natural[i]) {
          cols[i]++;
          remaining--;
          grew = true;
        }
      }
      if (!grew) break;
    }
  }

  // --- emit borders + rows ---
  const top = "┌─" + cols.map((w) => "─".repeat(w)).join("─┬─") + "─┐";
  const sep = "├─" + cols.map((w) => "─".repeat(w)).join("─┼─") + "─┤";
  const bot = "└─" + cols.map((w) => "─".repeat(w)).join("─┴─") + "─┘";
  out.push([{ text: top, classes: ["pi-table-border"] }]);

  function emitRow(rowCellLines, headerStyle) {
    const lineCount = Math.max(1, ...rowCellLines.map((c) => c.length));
    for (let li = 0; li < lineCount; li++) {
      const rowLine = [];
      rowLine.push({ text: "│ ", classes: ["pi-table-border"] });
      for (let ci = 0; ci < numCols; ci++) {
        const cellLine = rowCellLines[ci][li] || [];
        const text = runsText(cellLine);
        const w = cellWidth(text);
        const padding = " ".repeat(Math.max(0, cols[ci] - w));
        if (headerStyle) {
          rowLine.push(...withClasses(cellLine, ["pi-th"]));
        } else {
          rowLine.push(...cellLine);
        }
        rowLine.push({ text: padding, classes: [] });
        if (ci < numCols - 1) {
          rowLine.push({ text: " │ ", classes: ["pi-table-border"] });
        }
      }
      rowLine.push({ text: " │", classes: ["pi-table-border"] });
      out.push(rowLine);
    }
  }

  // Header
  const headerCellLines = token.header.map((cell, i) =>
    wrapRuns(inlineToRuns(cell.tokens || []), cols[i]),
  );
  emitRow(headerCellLines, true);
  out.push([{ text: sep, classes: ["pi-table-border"] }]);
  // Rows
  for (let ri = 0; ri < token.rows.length; ri++) {
    const row = token.rows[ri];
    const rowCellLines = row.map((cell, i) =>
      wrapRuns(inlineToRuns(cell.tokens || []), cols[i]),
    );
    emitRow(rowCellLines, false);
    if (ri < token.rows.length - 1) {
      out.push([{ text: sep, classes: ["pi-table-border"] }]);
    }
  }
  out.push([{ text: bot, classes: ["pi-table-border"] }]);
  return out;
}

// ---------- top-level token dispatch ----------

function renderBlock(token, width, nextType) {
  const lines = [];
  switch (token.type) {
    case "heading":
      lines.push(...renderHeading(token, width));
      if (nextType && nextType !== "space") lines.push([]);
      break;
    case "paragraph":
      lines.push(...renderParagraph(token, width));
      if (nextType && nextType !== "list" && nextType !== "space") lines.push([]);
      break;
    case "code":
      lines.push(...renderCode(token));
      if (nextType && nextType !== "space") lines.push([]);
      break;
    case "list":
      lines.push(...renderList(token, 0, width));
      break;
    case "table":
      lines.push(...renderTable(token, width));
      if (nextType && nextType !== "space") lines.push([]);
      break;
    case "blockquote":
      lines.push(...renderBlockquote(token, width));
      if (nextType && nextType !== "space") lines.push([]);
      break;
    case "hr":
      lines.push(...renderHr(width));
      if (nextType && nextType !== "space") lines.push([]);
      break;
    case "space":
      lines.push([]);
      break;
    case "html":
      if (typeof token.raw === "string") {
        const inner = [{ text: token.raw.trim(), classes: [] }];
        lines.push(...wrapRuns(inner, width));
      }
      break;
    default:
      if (typeof token.text === "string") {
        lines.push(
          ...wrapRuns([{ text: token.text, classes: [] }], width),
        );
      }
  }
  return lines;
}

// ---------- public API ----------

/**
 * Render markdown to a single HTML string in pi-tui's terminal style.
 *
 * Output is meant to live inside `<pre class="pi-md">...</pre>`.
 *
 * @param {string} text  markdown source
 * @param {number} width target width in monospace cells (>= 20)
 * @returns {string} HTML, with `\n` line separators and inline `<span class="pi-*">`s.
 */
export function renderMarkdownPi(text, width) {
  const marked = globalThis.marked;
  if (!text) return "";
  if (!marked) {
    // No marked loaded (e.g. early in tests). Render as plain text.
    return escHtml(text);
  }
  const w = Math.max(20, Math.floor(width || 80));
  // Match pi-tui's tab handling: 3 spaces.
  const normalized = text.replace(/\t/g, "   ");
  let tokens;
  try {
    tokens = marked.lexer(normalized);
  } catch {
    return escHtml(text);
  }
  const lines = [];
  for (let i = 0; i < tokens.length; i++) {
    lines.push(
      ...renderBlock(tokens[i], w, tokens[i + 1]?.type),
    );
  }
  // Drop trailing empties so the bubble doesn't end with blank rows.
  while (lines.length && lines[lines.length - 1].length === 0) lines.pop();
  return linesToHtml(lines);
}
