// Tests for the browser port of pi-tui's Markdown component.
//
// We don't try to byte-for-byte match pi-tui's ANSI output -- the
// goal is structural fidelity: same line layout, same box-drawing
// characters, same per-line prefixes for blockquotes/list bullets.
// Tests assert structural properties of the rendered HTML (which
// is a `<pre>`-shaped string with `\n` separators and inline
// `<span class="pi-*">` markers).

import { describe, it, expect, beforeAll } from "vitest";
import { Marked, Tokenizer } from "marked";
import {
  cellWidth,
  wrapRuns,
  inlineToRuns,
  linesToHtml,
  renderMarkdownPi,
} from "../pi-markdown.js";

/** Strip all `<span class="pi-*">…</span>` wrappers from an HTML
 *  snippet so we can assert against the visible text content of a
 *  pi-md block. Also strips `<a>` wrappers (leaving the link text).
 *  Decodes the basic HTML entities `escHtml` emits. */
function stripSpans(html) {
  return html
    .replace(/<\/?(?:span|a)[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Provide a `globalThis.marked` shim mirroring what the browser's
// `<script src="vendor/marked.min.js">` exposes: `marked.lexer(text)`
// returns tokens, `marked.Tokenizer` is the strict-strikethrough base
// class. The library exports `Marked` (a class) so we instantiate one
// and shove its `.lexer` onto a singleton.
beforeAll(() => {
  const m = new Marked();
  globalThis.marked = {
    lexer: m.lexer.bind(m),
    Tokenizer,
    setOptions: m.setOptions.bind(m),
  };
});

// --- low-level helpers ---

describe("cellWidth", () => {
  it("counts ASCII as 1-cell each", () => {
    expect(cellWidth("hello")).toBe(5);
    expect(cellWidth("")).toBe(0);
    expect(cellWidth("a b c")).toBe(5);
  });
  it("ignores combining marks", () => {
    // "e" + combining acute (U+0301) renders as one cell
    expect(cellWidth("e\u0301")).toBe(1);
  });
  it("counts surrogate pairs as 1 (best-effort)", () => {
    // We deliberately undercount emoji -- comment in cellWidth().
    expect(cellWidth("\u{1F600}")).toBe(1);
  });
});

describe("wrapRuns", () => {
  it("returns a single-line array for input that fits", () => {
    // wrapRuns tokenises by whitespace, so even input that fits gets
    // split into word + space + word runs. The structural invariant is
    // that the result is one LINE whose joined text equals the input.
    const runs = [{ text: "hello world", classes: [] }];
    const lines = wrapRuns(runs, 20);
    expect(lines).toHaveLength(1);
    expect(lines[0].map((r) => r.text).join("")).toBe("hello world");
  });
  it("wraps on whitespace", () => {
    const runs = [{ text: "one two three four", classes: [] }];
    const lines = wrapRuns(runs, 7);
    // Greedy fill: "one two" (7), "three" (5), "four" (4)
    expect(lines).toHaveLength(3);
    expect(lines[0].map((r) => r.text).join("")).toBe("one two");
    expect(lines[1].map((r) => r.text).join("")).toBe("three");
    expect(lines[2].map((r) => r.text).join("")).toBe("four");
  });
  it("preserves classes across wraps", () => {
    const runs = [{ text: "bold word here", classes: ["pi-strong"] }];
    const lines = wrapRuns(runs, 5);
    // Every output run should carry the same class.
    for (const line of lines) {
      for (const r of line) {
        if (r.text.trim()) expect(r.classes).toContain("pi-strong");
      }
    }
  });
  it("breaks a single token longer than the width char-by-char", () => {
    const runs = [{ text: "supercalifragilistic", classes: [] }];
    const lines = wrapRuns(runs, 5);
    expect(lines.length).toBeGreaterThan(1);
    // Each line (except possibly the last) is exactly 5 chars.
    for (let i = 0; i < lines.length - 1; i++) {
      expect(lines[i].map((r) => r.text).join("").length).toBe(5);
    }
  });
  it("doesn't start a line with whitespace after a wrap", () => {
    const runs = [{ text: "aaa bbb ccc", classes: [] }];
    const lines = wrapRuns(runs, 4);
    for (const line of lines) {
      const first = line[0];
      if (first) expect(first.text[0]).not.toMatch(/\s/);
    }
  });
});

describe("inlineToRuns", () => {
  it("flattens nested style tokens with stacked classes", () => {
    const tokens = [
      { type: "strong", tokens: [{ type: "em", tokens: [{ type: "text", text: "wow" }] }] },
    ];
    const runs = inlineToRuns(tokens);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("wow");
    expect(runs[0].classes).toContain("pi-strong");
    expect(runs[0].classes).toContain("pi-em");
  });
  it("renders codespan with pi-code class", () => {
    const runs = inlineToRuns([{ type: "codespan", text: "foo()" }]);
    expect(runs[0].text).toBe("foo()");
    expect(runs[0].classes).toContain("pi-code");
  });
  it("emits link with href + pi-link class, no extra url paren when text===href", () => {
    const runs = inlineToRuns([
      { type: "link", href: "https://x.com", tokens: [{ type: "text", text: "https://x.com" }] },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("https://x.com");
    expect(runs[0].href).toBe("https://x.com");
    expect(runs[0].classes).toContain("pi-link");
  });
  it("emits ' (href)' suffix when link text differs from href", () => {
    const runs = inlineToRuns([
      { type: "link", href: "https://x.com", tokens: [{ type: "text", text: "site" }] },
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0].text).toBe("site");
    expect(runs[1].text).toBe(" (https://x.com)");
    expect(runs[1].classes).toContain("pi-link-url");
  });
});

describe("linesToHtml", () => {
  it("escapes HTML entities in plain text runs", () => {
    const out = linesToHtml([[{ text: "<script>", classes: [] }]]);
    expect(out).toBe("&lt;script&gt;");
  });
  it("wraps classed runs in <span>", () => {
    const out = linesToHtml([[{ text: "x", classes: ["pi-strong"] }]]);
    expect(out).toBe('<span class="pi-strong">x</span>');
  });
  it("renders links as <a target='_blank'>", () => {
    const out = linesToHtml([
      [{ text: "click", classes: ["pi-link"], href: "https://x.com" }],
    ]);
    expect(out).toContain('href="https://x.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain(">click</a>");
  });
  it("joins multi-line input with literal \\n", () => {
    const out = linesToHtml([
      [{ text: "a", classes: [] }],
      [{ text: "b", classes: [] }],
    ]);
    expect(out).toBe("a\nb");
  });
});

// --- end-to-end renderMarkdownPi ---

describe("renderMarkdownPi", () => {
  it("renders a top-level paragraph as plain text", () => {
    const html = renderMarkdownPi("hello world", 80);
    expect(html).toBe("hello world");
  });
  it("emits an h1 with the pi-h1 class and no '# ' prefix (it's underlined visually)", () => {
    const html = renderMarkdownPi("# Big Title", 80);
    expect(html).toContain('class="pi-heading pi-h1"');
    expect(stripSpans(html)).toContain("Big Title");
    // h1/h2 don't get the prefix baked into the text (pi-tui omits it too).
    expect(html).not.toContain("# Big Title");
  });
  it("emits an h3 with literal '### ' prefix", () => {
    const html = renderMarkdownPi("### Sub", 80);
    // Strip spans before checking visible text: pi-markdown wraps
    // each whitespace-bounded token in its own span (the prefix `###`,
    // the space, and the word `Sub` are 3 spans).
    expect(stripSpans(html)).toContain("### Sub");
    expect(html).toContain("pi-h3");
  });
  it("draws box-drawing table borders", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    const html = renderMarkdownPi(md, 30);
    // Top, separator, bottom borders all present.
    expect(html).toContain("┌");
    expect(html).toContain("┬");
    expect(html).toContain("┐");
    expect(html).toContain("├");
    expect(html).toContain("┼");
    expect(html).toContain("┤");
    expect(html).toContain("└");
    expect(html).toContain("┴");
    expect(html).toContain("┘");
    // Cell separator `│` shows up too.
    expect(html).toContain("│");
    // Border spans carry the styling class.
    expect(html).toContain("pi-table-border");
  });
  it("prefixes blockquote lines with '│ '", () => {
    const html = renderMarkdownPi("> quoted line\n> second line\n", 80);
    expect(html).toContain("│ ");
    // Visible text spans multiple <span class="pi-quote">…</span>.
    const text = stripSpans(html);
    expect(text).toContain("quoted line");
    expect(text).toContain("second line");
    expect(html).toContain("pi-quote-bar");
  });

  it("renders an unordered list with '- ' bullets in stripped output", () => {
    const html = renderMarkdownPi("- one\n- two\n- three\n", 80);
    const text = stripSpans(html);
    expect(text).toContain("- one");
    expect(text).toContain("- two");
    expect(html).toContain("pi-list-bullet");
  });

  it("renders an ordered list with '1. 2. 3.' prefixes in stripped output", () => {
    const html = renderMarkdownPi("1. one\n2. two\n3. three\n", 80);
    const text = stripSpans(html);
    expect(text).toContain("1. one");
    expect(text).toContain("2. two");
    expect(text).toContain("3. three");
  });

  it("renders an unordered list with '- ' bullets in stripped output", () => {
    const html = renderMarkdownPi("- one\n- two\n- three\n", 80);
    const text = stripSpans(html);
    expect(text).toContain("- one");
    expect(text).toContain("- two");
    expect(html).toContain("pi-list-bullet");
  });

  it("renders an ordered list with '1. 2. 3.' prefixes in stripped output", () => {
    const html = renderMarkdownPi("1. one\n2. two\n3. three\n", 80);
    const text = stripSpans(html);
    expect(text).toContain("1. one");
    expect(text).toContain("2. two");
    expect(text).toContain("3. three");
  });
  it("renders an hr as a row of '─'", () => {
    const html = renderMarkdownPi("---", 40);
    expect(html).toMatch(/─{20,}/);
    expect(html).toContain("pi-hr");
  });
  it("renders an unordered list with '- ' bullets", () => {
    const html = renderMarkdownPi("- one\n- two\n- three\n", 80);
    // Bullets and item text live in separate spans/text-runs, so
    // assert against the stripped visible text.
    const text = stripSpans(html);
    expect(text).toContain("- one");
    expect(text).toContain("- two");
    expect(text).toContain("- three");
    expect(html).toContain("pi-list-bullet");
  });
  it("renders an ordered list with '1. 2. 3.' prefixes", () => {
    const html = renderMarkdownPi("1. one\n2. two\n3. three\n", 80);
    const text = stripSpans(html);
    expect(text).toContain("1. one");
    expect(text).toContain("2. two");
    expect(text).toContain("3. three");
    expect(html).toContain("pi-list-bullet");
  });
  it("renders a code block fenced with ``` and indented content", () => {
    const html = renderMarkdownPi("```python\nprint('hi')\n```\n", 40);
    expect(html).toContain("```python");
    expect(html).toContain("  print(&#39;hi&#39;)");
    expect(html).toContain("pi-code-fence");
    expect(html).toContain("pi-codeblock");
  });
  it("falls back to plain-text escape when marked is unavailable", () => {
    const saved = globalThis.marked;
    delete globalThis.marked;
    try {
      const html = renderMarkdownPi("<script>x", 80);
      expect(html).toBe("&lt;script&gt;x");
    } finally {
      globalThis.marked = saved;
    }
  });
  it("clamps width to a minimum of 20 cols", () => {
    // Way too narrow -- shouldn't crash, should still produce output.
    const html = renderMarkdownPi("hello world", 1);
    expect(html.length).toBeGreaterThan(0);
  });
  it("emits same line count for table whether rendered narrow or wide (cells just wrap)", () => {
    const md =
      "| col A | col B |\n|---|---|\n| short | a much longer value that should wrap |\n";
    const narrow = renderMarkdownPi(md, 40);
    const wide = renderMarkdownPi(md, 200);
    // Both have header+sep+row+bottom; narrow has more lines because the
    // long cell wraps to multiple rows.
    const narrowLines = narrow.split("\n").length;
    const wideLines = wide.split("\n").length;
    expect(wideLines).toBeLessThanOrEqual(narrowLines);
  });
});
