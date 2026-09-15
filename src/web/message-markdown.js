// Shared by finalized messages and the live streaming update path.
import { escHtml, enhanceImagePaths, renderMarkdown } from "./render.js";
import { renderMarkdownPi } from "./pi-markdown.js";
import { renderMathMarkdown } from "./math-markdown.js";

export function renderMessageMarkdown(text, { widthCols, raw = false, agentId, cursor = "" } = {}) {
  if (raw) {
    return `<pre class="whitespace-pre-wrap text-base16-600 font-mono">${escHtml(text)}${cursor}</pre>`;
  }
  const math = renderMathMarkdown(text);
  const flow = math !== null || !widthCols;
  const rendered = math ?? (widthCols ? renderMarkdownPi(text, widthCols) : renderMarkdown(text));
  const { html, thumbnails } = agentId
    ? enhanceImagePaths(rendered, agentId)
    : { html: rendered, thumbnails: "" };
  return flow
    ? `<div class="md text-base16-600${math !== null ? " math-document" : ""}">${html}${cursor}</div>${thumbnails}`
    : `<pre class="pi-md">${html}${cursor}</pre>${thumbnails}`;
}
