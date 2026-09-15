import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { safeLinkUrl, isRasterDataUrl } from "../content-policy.js";
import { renderMarkdown, enhanceImagePaths } from "../render.js";
import { renderMarkdownPi } from "../pi-markdown.js";
import { renderMathMarkdown } from "../math-markdown.js";
import { renderMessageMarkdown } from "../message-markdown.js";
import { renderMessage } from "../transcript.js";

const dom = (html) => JSDOM.fragment(html);
const renderers = [renderMarkdown, (s) => renderMarkdownPi(s, 120), (s) => renderMathMarkdown("$x$\n\n" + s)];

describe("untrusted message content", () => {
  it.each(renderers)("escapes source HTML rather than preserving styles/resources (%#)", (render) => {
    const source = '<div style="position:fixed;inset:0;background:url(https://example.com/pixel)"><img src="https://example.com/x.png" onerror="alert(1)"><script>alert(1)</script></div>';
    const root = dom(render(source));
    expect(root.querySelector("div[style], img, script")).toBeNull();
    expect(root.textContent).toContain('<div style="position:fixed');
    const nested = dom(render('> inline <span style="position:fixed">overlay</span>\n\n- <iframe src="https://example.com"></iframe>'));
    expect(nested.querySelector("[style*=fixed], iframe")).toBeNull();
  });

  it.each(renderers)("restricts links and escapes attributes (%#)", (render) => {
    for (const url of ["javascript:alert%281%29", "data:text/html,test", "vbscript:test", "file:///tmp/a"]) {
      expect(dom(render(`[click](${url})`)).querySelector("a")).toBeNull();
    }
    for (const url of ["https://example.com/?a=1&b=2", "mailto:test@example.com", "./notes", "#section"]) {
      const a = dom(render(`[click](${url})`)).querySelector("a");
      expect(a?.getAttribute("href")).toBe(url);
      expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    }
    const encoded = dom(render('[click](javascript&colon;alert%281%29)')).querySelector("a");
    expect(encoded?.getAttribute("href") || "").not.toMatch(/^javascript:/i);
  });

  it.each(renderers)("does not automatically load remote images (%#)", (render) => {
    for (const src of ["https://example.com/pixel.png", "//example.com/pixel.png", "data:image/svg+xml,test", "/arbitrary-api.png"]) {
      expect(dom(render(`![image](${src})`)).querySelector("img")).toBeNull();
    }
  });

  it("keeps local image enhancement without inline handlers", () => {
    const root = dom(renderMessageMarkdown("$x$ ![plot](plots/chart.svg)", { agentId: "demo", widthCols: 80 }));
    expect(root.querySelector("img").getAttribute("src")).toBe("/api/agents/demo/file?path=plots%2Fchart.svg");
    expect(root.querySelector("[onerror]")).toBeNull();
    const special = dom(enhanceImagePaths("<code>a&amp;quot;.png</code>", "demo").thumbnails);
    expect(special.querySelector("img").getAttribute("alt")).toBe("a&quot;.png");
  });

  it.each(["user", "tool_result"])("validates %s image attachment URLs", (role) => {
    const urls = ["https://example.com/x.png", 'x" onerror="alert(1)', "data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,AQID"];
    const root = dom(renderMessage({ role, content: "image", ts: 0, images: urls.map((dataUrl) => ({ dataUrl })) }, 0));
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector("img").getAttribute("src")).toBe(urls.at(-1));
    expect(root.querySelector("[onerror]")).toBeNull();
  });
});

describe("URL validation", () => {
  it.each(["java\tscript:alert(1)", "\njavascript:alert(1)", "javascript:alert(1)", "data:text/html,x", "\\\\example.com", "https://example.com/\u0000", null])( "rejects unsafe URL %j", (url) => {
    expect(safeLinkUrl(url)).toBeNull();
  });
  it("only accepts base64 raster attachments", () => {
    expect(isRasterDataUrl("data:image/png;base64,AQID==")).toBe(true);
    expect(isRasterDataUrl("data:image/svg+xml;base64,AQID")).toBe(false);
    expect(isRasterDataUrl('data:image/png;base64,AQID" onerror="x')).toBe(false);
  });
});
