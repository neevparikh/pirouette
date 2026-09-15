import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { renderMathMarkdown } from "../math-markdown.js";
import { renderMessageMarkdown } from "../message-markdown.js";
import { renderMessage } from "../transcript.js";

const dom = (html) => JSDOM.fragment(html);

describe("math Markdown", () => {
  it.each([
    [String.raw`The mean is \(\bar{x}=\frac{1}{n}\sum_i x_i\).`, false],
    [String.raw`The mean is $\bar{x}=\frac{1}{n}\sum_i x_i$.`, false],
    [String.raw`\[\sum_{i=1}^{n} x_i\]`, true],
    [String.raw`$$\sum_{i=1}^{n} x_i$$`, true],
  ])("renders standard delimiters: %s", (source, display) => {
    const html = renderMathMarkdown(source);
    const root = dom(html);
    expect(root.querySelectorAll(".katex")).toHaveLength(1);
    expect(!!root.querySelector(".katex-display")).toBe(display);
    expect(root.querySelector("math semantics annotation")?.getAttribute("encoding")).toBe("application/x-tex");
  });

  it("preserves TeX before Markdown can eat escapes, underscores, or line breaks", () => {
    const source = String.raw`Before.
\[
\begin{aligned}
y_1 &= \frac{x_1}{2} \\
y_2 &= \sqrt{x_2}
\end{aligned}
\]
After.`;
    const root = dom(renderMathMarkdown(source));
    expect(root.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(root.querySelector("annotation")?.textContent).toContain(String.raw`y_1 &= \frac{x_1}{2} \\`);
    expect(root.querySelector(".katex-html .mfrac")).not.toBeNull();
    expect(root.querySelector("svg path")).not.toBeNull();
    expect(root.textContent).toContain("Before.");
    expect(root.textContent).toContain("After.");
  });

  it("renders math in emphasis, lists, quotes and table cells using flow layout", () => {
    const source = String.raw`**For \(x_i\)**:

- Mean: $\mu$
- Spread: $\sigma$

> Let \(n=3\).

| Symbol | Value |
| --- | --- |
| $x_1$ | $\frac{1}{2}$ |`;
    const root = dom(renderMessageMarkdown(source, { widthCols: 20 }));
    expect(root.querySelector(".math-document")).not.toBeNull();
    expect(root.querySelector("pre")).toBeNull();
    expect(root.querySelector("strong .katex")).not.toBeNull();
    expect(root.querySelectorAll("li .katex")).toHaveLength(2);
    expect(root.querySelector("blockquote .katex")).not.toBeNull();
    expect(root.querySelectorAll("td .katex")).toHaveLength(2);
  });

  it.each([
    "ordinary **Markdown**",
    "costs $5 and $10, or $20.50 tomorrow",
    "the budget is $100",
    String.raw`escaped \$x\$ and \\(y\\)`,
    '`$x$` and `\\(y\\)`',
    '```latex\n\\[x^2\\]\n```',
    '    $$x$$',
    '[link](https://example.com/$x$)',
    '<span title="$x$">text</span>',
    '$not\ninline$',
  ])("does not treat literal content as math: %s", (source) => {
    expect(renderMathMarkdown(source)).toBeNull();
  });

  it("leaves code literal even when the message also contains real math", () => {
    const source = 'Math $x_i$, code `$y$`.\n\n```tex\n\\[z\\]\n```';
    const root = dom(renderMathMarkdown(source));
    expect(root.querySelectorAll(".katex")).toHaveLength(1);
    expect(root.querySelector("code").textContent).toBe("$y$");
    expect(root.querySelector("pre code").textContent.trim()).toBe(String.raw`\[z\]`);
  });

  it("does not close math on escaped dollars or delimiters inside braces", () => {
    const root = dom(renderMathMarkdown(String.raw`$\text{price: \$5}+x$ and \(\text{\)}+y\)`));
    expect(root.querySelector("annotation").textContent).toContain(String.raw`\$5`);
    // KaTeX rejects \) inside \text, but the entire expression must be
    // one fallback, not truncated at the delimiter inside the braces.
    expect(root.querySelector(".math-fallback").textContent).toBe(String.raw`\(\text{\)}+y\)`);
  });

  it("renders each streaming prefix safely and typesets once the delimiter closes", () => {
    const source = String.raw`An equation:
\[
\frac{a+b}{c}
\]`;
    for (let i = 1; i <= source.length; i++) {
      const root = dom(renderMessageMarkdown(source.slice(0, i), { widthCols: 80 }));
      expect(root.querySelectorAll(".katex")).toHaveLength(i === source.length ? 1 : 0);
    }
    const partial = String.raw`Before \(\frac{a}{`;
    expect(dom(renderMathMarkdown(partial)).textContent.trim()).toBe(partial);
  });

  it("falls back locally for unsupported TeX without hiding surrounding Markdown", () => {
    const root = dom(renderMathMarkdown(String.raw`**Before** \(\notARealCommand{x}\) and $y$ after.`));
    expect(root.querySelector("strong").textContent).toBe("Before");
    expect(root.querySelector(".math-fallback").textContent).toBe(String.raw`\(\notARealCommand{x}\)`);
    expect(root.querySelectorAll(".katex")).toHaveLength(1);
    expect(root.textContent).toContain("after.");
  });

  it("bounds macro expansion and does not share macros between equations", () => {
    const root = dom(renderMathMarkdown(String.raw`\(\def\loop{\loop}\loop\) then \(\gdef\local{z}\local\) and \(\local\)`));
    expect(root.querySelectorAll(".math-fallback")).toHaveLength(2);
    expect(root.querySelectorAll(".katex")).toHaveLength(1);
  });

  it("caches completed equations across streaming updates", () => {
    const spy = vi.spyOn(globalThis.katex, "renderToString");
    try {
      const equation = String.raw`\(\frac{98765}{43210}\)`;
      renderMathMarkdown(equation);
      renderMathMarkdown(equation + " more text");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("escapes fallback text and disallows unsafe TeX and Markdown HTML", () => {
    const source = String.raw`<script>alert(1)</script><img src="x" onerror="alert(1)">
\(\href{javascript:alert(1)}{click}\)
\(\includegraphics{https://example.com/leak.png}\)
\(\htmlStyle{position:fixed}{bad}\)
\(\notARealCommand{<img src=x onerror=alert(1)>}\)`;
    const root = dom(renderMathMarkdown(source));
    expect(root.querySelector("script, [onerror], [style*=fixed], a[href^='javascript:']")).toBeNull();
    expect(root.querySelector("img[src*='leak']")).toBeNull();
    expect(root.querySelector(".math-fallback").textContent).toContain("<img");
  });

  it("keeps readable source when KaTeX is unavailable", () => {
    const saved = globalThis.katex;
    try {
      delete globalThis.katex;
      const source = String.raw`\[x<y\]`;
      expect(dom(renderMathMarkdown(source)).textContent.trim()).toBe(source);
    } finally {
      globalThis.katex = saved;
    }
  });
});

describe("message math integration", () => {
  it.each([false, true])("supports assistant messages (streaming=%s)", (streaming) => {
    const msg = { role: "assistant", content: String.raw`\[x^2+y^2=z^2\]`, streaming, ts: 0 };
    const root = dom(renderMessage(msg, 0, undefined, { widthCols: 80 }));
    expect(root.querySelector(".katex-display")).not.toBeNull();
    expect(root.querySelector("pre .math-document")).toBeNull();
    const raw = dom(renderMessage(msg, 0, undefined, { widthCols: 80, rawAssistant: true }));
    expect(raw.querySelector(".katex")).toBeNull();
    expect(raw.textContent).toContain(msg.content);
  });

  it("supports user messages", () => {
    const root = dom(renderMessage({ role: "user", content: "$x$", ts: 0 }, 0, undefined, { widthCols: 80 }));
    expect(root.querySelector(".pi-row-user .katex")).not.toBeNull();
  });

  it("retains terminal rendering and box-drawing when there is no math", () => {
    const root = dom(renderMessageMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", { widthCols: 80 }));
    expect(root.querySelector("pre.pi-md")).not.toBeNull();
    expect(root.textContent).toContain("┌");
  });

  it("preserves image enhancement in math messages", () => {
    const root = dom(renderMessageMarkdown("$x$ and `plot.png`", { widthCols: 80, agentId: "demo" }));
    expect(root.querySelector(".katex")).not.toBeNull();
    expect(root.querySelector('img[src*="/api/agents/demo/file"]')).not.toBeNull();
  });
});
