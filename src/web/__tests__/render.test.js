import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  describeToolCall,
  describeToolResult,
  enhanceImagePaths,
  escHtml,
  looksLikeImagePathRef,
  parseToolArgs,
  relTime,
  renderDiff,
  renderMarkdown,
  shortenPath,
} from "../render.js";

describe("escHtml", () => {
  it("escapes core HTML entities", () => {
    expect(escHtml("<script>alert('x')</script>")).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
    );
  });
  it("handles null/undefined/empty", () => {
    expect(escHtml(null)).toBe("");
    expect(escHtml(undefined)).toBe("");
    expect(escHtml("")).toBe("");
  });
  it("escapes & once", () => {
    expect(escHtml("a & b")).toBe("a &amp; b");
  });
  it("coerces non-strings", () => {
    expect(escHtml(42)).toBe("42");
  });
});

describe("shortenPath", () => {
  it("strips home directory to ~", () => {
    expect(shortenPath("/Users/neev/repos/project")).toBe("~/repos/project");
  });
  it("strips pirouette worktree prefix to project-relative", () => {
    expect(
      shortenPath("/Users/neev/repos/pirouette/.pirouette/data/worktrees/foo/src/index.ts"),
    ).toBe("src/index.ts");
  });
  it("shows worktrees/<name> when it's the workdir root", () => {
    expect(
      shortenPath("/Users/neev/repos/pirouette/.pirouette/data/worktrees/foo"),
    ).toBe("worktrees/foo");
  });
  it("passes through non-matching paths", () => {
    expect(shortenPath("/etc/passwd")).toBe("/etc/passwd");
    expect(shortenPath("")).toBe("");
  });
});

describe("parseToolArgs", () => {
  it("returns the object when given one", () => {
    expect(parseToolArgs({ a: 1 })).toEqual({ a: 1 });
  });
  it("parses JSON strings", () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
  });
  it("wraps invalid JSON in _raw", () => {
    expect(parseToolArgs("not json")).toEqual({ _raw: "not json" });
  });
  it("returns null for null/empty", () => {
    expect(parseToolArgs(null)).toBeNull();
    expect(parseToolArgs(undefined)).toBeNull();
  });
});

describe("describeToolCall", () => {
  it("bash with description uses it as header and command as subtitle", () => {
    const r = describeToolCall("bash", { command: "ls -la", description: "list files" });
    expect(r.header).toBe("list files");
    expect(r.subtitle).toBe("ls -la");
    expect(r.body).toBe("");
  });
  it("bash with multiline command puts first line in subtitle and full in body", () => {
    const r = describeToolCall("bash", { command: "cd foo\nls\npwd" });
    expect(r.subtitle).toBe("cd foo");
    expect(r.body).toBe("cd foo\nls\npwd");
  });
  it("read shows path and line range", () => {
    const r = describeToolCall("read", {
      file_path: "/Users/neev/a/b.ts",
      offset: 10,
      limit: 50,
    });
    expect(r.header).toBe("read");
    expect(r.subtitle).toBe("~/a/b.ts (from line 10, 50 lines)");
  });
  it("edit renders a diff body", () => {
    const r = describeToolCall("edit", {
      file_path: "/x.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(r.header).toBe("edit");
    expect(r.subtitle).toBe("/x.ts");
    expect(r.bodyIsRich).toBe(true);
    expect(r.body).toContain("diff-del");
    expect(r.body).toContain("diff-add");
    expect(r.body).toMatch(/- a/);
    expect(r.body).toMatch(/\+ b/);
  });
  it("write shows line count and preview", () => {
    const content = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    const r = describeToolCall("write", { file_path: "/x", content });
    expect(r.subtitle).toBe("/x (15 lines)");
    expect(r.body).toContain("line 1");
    expect(r.body).toContain("line 10");
    expect(r.body).toContain("… (15 lines total)");
  });
  it("grep shows pattern, path, and type filter", () => {
    const r = describeToolCall("grep", {
      pattern: "TODO",
      path: "/proj/src",
      type: "ts",
    });
    expect(r.header).toBe("grep");
    expect(r.subtitle).toContain("TODO");
    expect(r.subtitle).toContain("in /proj/src");
    expect(r.subtitle).toContain("ts");
  });
  it("unknown tool falls back to JSON body", () => {
    const r = describeToolCall("my_custom_tool", { foo: 1 });
    expect(r.header).toBe("my_custom_tool");
    expect(r.body).toContain('"foo"');
  });
  it("handles missing args", () => {
    expect(describeToolCall("bash", null)).toEqual({
      header: "bash",
      subtitle: "",
      body: "",
      bodyIsRich: false,
    });
  });
});

describe("describeToolResult", () => {
  it("read → line count", () => {
    expect(describeToolResult("read", "a\nb\nc")).toBe("3 lines");
  });
  it("grep → match count", () => {
    expect(describeToolResult("grep", "a.ts:1:foo\nb.ts:3:foo\n")).toBe("2 matches");
  });
  it("grep → no matches", () => {
    expect(describeToolResult("grep", "no matches found")).toBe("no matches");
  });
  it("ls → entry count", () => {
    expect(describeToolResult("ls", "foo\nbar\nbaz")).toBe("3 entries");
  });
  it("bash → lines of output only if > 3", () => {
    expect(describeToolResult("bash", "one")).toBeNull();
    expect(describeToolResult("bash", "a\nb\nc\nd\ne")).toBe("5 lines of output");
  });
  it("returns null for errors", () => {
    expect(describeToolResult("read", "stuff", true)).toBeNull();
  });
  it("returns null for empty content", () => {
    expect(describeToolResult("bash", "")).toBeNull();
  });
});

describe("renderDiff", () => {
  it("renders deletions then additions", () => {
    const html = renderDiff("old1\nold2", "new1");
    expect(html).toMatch(/- old1/);
    expect(html).toMatch(/- old2/);
    expect(html).toMatch(/\+ new1/);
    expect(html.indexOf("- old1")).toBeLessThan(html.indexOf("+ new1"));
  });
  it("escapes HTML in content", () => {
    const html = renderDiff("<x>", "<y>");
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&lt;y&gt;");
  });
  it("handles empty lines with nbsp", () => {
    const html = renderDiff("", "");
    expect(html).toContain("&nbsp;");
  });
  it("preserves leading indentation in emitted HTML", () => {
    // Regression test: the diff renderer must emit leading whitespace
    // verbatim so the `white-space: pre-wrap` rule on .diff-line can
    // render indentation in the browser. If escHtml or the template
    // ever starts trimming, this catches it.
    const html = renderDiff("    indented_old()", "\tindented_new()");
    expect(html).toContain("-     indented_old()");
    expect(html).toContain("+ \tindented_new()");
  });
  it("has matching CSS that preserves whitespace on .diff-line", () => {
    // The HTML output above only renders indentation in the browser if
    // index.html declares a whitespace-preserving rule on .diff-line.
    // Pin that here so a stylesheet edit that drops it fails loudly.
    const here = dirname(fileURLToPath(import.meta.url));
    const indexHtml = readFileSync(resolve(here, "../index.html"), "utf8");
    expect(indexHtml).toMatch(
      /\.diff-line\s*\{[^}]*white-space:\s*pre(?:-wrap)?\b/,
    );
  });
});

describe("renderMarkdown", () => {
  it("renders headings and lists", () => {
    const html = renderMarkdown("# Title\n\n- item 1\n- item 2");
    expect(html).toMatch(/<h1>/);
    expect(html).toMatch(/<ul>/);
    expect(html).toMatch(/<li>item 1<\/li>/);
  });
  it("renders fenced code blocks", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    expect(html).toMatch(/<pre>/);
    expect(html).toContain("const x = 1;");
  });
  it("sanitizes dangerous HTML", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });
  it("falls back to plain text for empty input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown(null)).toBe("");
  });
});

describe("relTime", () => {
  const now = 1_000_000_000;
  it('returns "just now" for sub-2s', () => {
    expect(relTime(now - 500, now)).toBe("just now");
  });
  it("returns seconds for <1m", () => {
    expect(relTime(now - 30_000, now)).toBe("30s ago");
  });
  it("returns minutes for <1h", () => {
    expect(relTime(now - 5 * 60_000, now)).toBe("5m ago");
  });
  it("returns hours for <1d", () => {
    expect(relTime(now - 3 * 3600_000, now)).toBe("3h ago");
  });
  it("returns days for >=1d", () => {
    expect(relTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

describe("looksLikeImagePathRef", () => {
  it("accepts simple relative image paths", () => {
    expect(looksLikeImagePathRef("plots/foo.png")).toBe(true);
    expect(looksLikeImagePathRef("foo.png")).toBe(true);
    expect(looksLikeImagePathRef("./foo.jpg")).toBe(true);
    expect(looksLikeImagePathRef("a/b/c.webp")).toBe(true);
    expect(looksLikeImagePathRef("SVG_Logo.svg")).toBe(true);
  });
  it("rejects URLs and absolute paths", () => {
    expect(looksLikeImagePathRef("https://example.com/x.png")).toBe(false);
    expect(looksLikeImagePathRef("http://x.png")).toBe(false);
    expect(looksLikeImagePathRef("data:image/png;base64,xxx")).toBe(false);
    expect(looksLikeImagePathRef("file:///etc/x.png")).toBe(false);
    expect(looksLikeImagePathRef("/etc/passwd.png")).toBe(false);
    expect(looksLikeImagePathRef("/abs.png")).toBe(false);
  });
  it("rejects non-image extensions", () => {
    expect(looksLikeImagePathRef("foo.txt")).toBe(false);
    expect(looksLikeImagePathRef("foo.md")).toBe(false);
    expect(looksLikeImagePathRef("script.js")).toBe(false);
    expect(looksLikeImagePathRef("plot")).toBe(false); // no ext
  });
  it("rejects prose-like strings even with image-ext suffix", () => {
    expect(looksLikeImagePathRef("a sentence with foo.png inside")).toBe(false);
    expect(looksLikeImagePathRef('quoted"foo.png')).toBe(false);
    expect(looksLikeImagePathRef("trailing\nfoo.png")).toBe(false);
    expect(looksLikeImagePathRef("<tagged>foo.png")).toBe(false);
  });
  it("rejects empty or oversized inputs", () => {
    expect(looksLikeImagePathRef("")).toBe(false);
    expect(looksLikeImagePathRef("a".repeat(600))).toBe(false);
    expect(looksLikeImagePathRef(null)).toBe(false);
    expect(looksLikeImagePathRef(undefined)).toBe(false);
    expect(looksLikeImagePathRef(123)).toBe(false);
  });
});

describe("enhanceImagePaths", () => {
  // v0.12.4 changed the return shape to { html, thumbnails } so that
  // thumbnails can render BELOW the markdown block (not inside it).
  // Inline injection would have disrupted `<pre class="pi-md">`'s
  // `white-space: pre` column alignment.
  it("rewrites <img src> with relative path to /file endpoint", () => {
    const html = '<img src="plots/foo.png" alt="foo">';
    const { html: out } = enhanceImagePaths(html, "agent-1");
    expect(out).toContain('src="/api/agents/agent-1/file?path=plots%2Ffoo.png"');
    expect(out).toContain('alt="foo"');
    expect(out).toContain("max-h-64");
    expect(out).toContain('loading="lazy"');
  });
  it("does not rewrite absolute or remote img srcs", () => {
    const html =
      '<img src="https://cdn.example/x.png"><img src="/abs/y.png">';
    const { html: out } = enhanceImagePaths(html, "agent-1");
    expect(out).toContain('src="https://cdn.example/x.png"');
    expect(out).toContain('src="/abs/y.png"');
    expect(out).not.toContain("/api/agents/agent-1/file");
  });
  it("emits a thumbnail strip for legacy <code>image-path</code> spans", () => {
    const html = "see <code>plots/foo.png</code> for the result";
    const { html: out, thumbnails } = enhanceImagePaths(html, "agent-1");
    // original <code> stays untouched -- no inline injection
    expect(out).toBe(html);
    // thumbnail strip carries the rewritten endpoint URL
    expect(thumbnails).toContain('href="/api/agents/agent-1/file?path=plots%2Ffoo.png"');
    expect(thumbnails).toContain('alt="plots/foo.png"');
    expect(thumbnails).toContain('class="pi-image-strip');
  });
  it("emits a thumbnail strip for pi-md <span class=\"pi-code\"> spans", () => {
    const html = 'see <span class="pi-code">plots/bar.png</span> here';
    const { html: out, thumbnails } = enhanceImagePaths(html, "agent-1");
    expect(out).toBe(html);
    expect(thumbnails).toContain('href="/api/agents/agent-1/file?path=plots%2Fbar.png"');
    expect(thumbnails).toContain("pi-image-strip");
  });
  it("deduplicates paths mentioned multiple times", () => {
    const html =
      '<span class="pi-code">a.png</span> and <span class="pi-code">a.png</span> again';
    const { thumbnails } = enhanceImagePaths(html, "agent-1");
    // Each thumbnail is one <a href=...> tile; deduped path => 1 tile.
    const tiles = (thumbnails.match(/<a\s+href=/g) || []).length;
    expect(tiles).toBe(1);
  });
  it("handles compound pi-* classes on the inline-code span", () => {
    // pi-md may stack classes (e.g. pi-strong + pi-code when bold inline-code)
    const html = '<span class="pi-strong pi-code">plots/foo.png</span>';
    const { thumbnails } = enhanceImagePaths(html, "agent-1");
    expect(thumbnails).toContain("path=plots%2Ffoo.png");
  });
  it("ignores hljs-marked code blocks (don't flood code listings)", () => {
    const html =
      '<pre><code class="hljs language-bash">plots/foo.png\nplots/bar.png</code></pre>';
    const { thumbnails } = enhanceImagePaths(html, "agent-1");
    expect(thumbnails).toBe("");
  });
  it("emits no thumbnails when no image-paths are present", () => {
    const html = "use <code>npm install foo</code> first";
    const { html: out, thumbnails } = enhanceImagePaths(html, "agent-1");
    expect(out).toBe(html);
    expect(thumbnails).toBe("");
  });
  it("no-ops without agentId: returns { html: input, thumbnails: '' }", () => {
    const html = '<img src="plots/foo.png">';
    for (const aid of ["", null, undefined]) {
      const r = enhanceImagePaths(html, aid);
      expect(r.html).toBe(html);
      expect(r.thumbnails).toBe("");
    }
  });
  it("decodes HTML entities inside <code> before path detection", () => {
    const html = "<code>my-file.png</code>";
    const { thumbnails } = enhanceImagePaths(html, "agent-1");
    expect(thumbnails).toContain('href="/api/agents/agent-1/file?path=my-file.png"');
  });
});
