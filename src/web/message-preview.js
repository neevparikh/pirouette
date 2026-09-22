// Fold rendered messages by visual height rather than source newlines, so
// pasted paragraphs and Markdown stay compact at desktop and mobile widths.
import { escHtml } from "./render.js";

export function renderMessagePreview(body, key, expanded, label) {
  const isExpanded = expanded.has(key);
  const id = `message-body:${key}`;
  return `<div class="message-preview">
    <div id="${escHtml(id)}" class="message-preview-body${isExpanded ? "" : " is-collapsed"}">${body}</div>
    <button type="button" class="message-expand" data-toggle="${escHtml(key)}" aria-controls="${escHtml(id)}" aria-expanded="${isExpanded}" aria-label="${isExpanded ? "Collapse" : "Expand"} ${escHtml(label)}">${isExpanded ? "Show less" : "Show all"} <span aria-hidden="true">${isExpanded ? "▴" : "▾"}</span></button>
  </div>`;
}

/** Run after rendering and on resize. Measuring rendered height accounts for
 * word wrapping, Markdown spacing, code fences, and math without guessing. */
export function syncMessagePreviews(container) {
  for (const preview of container.querySelectorAll(".message-preview")) {
    const body = preview.querySelector(".message-preview-body");
    const button = preview.querySelector(".message-expand");
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.hidden = !expanded && body.scrollHeight <= body.clientHeight + 1;
  }
}
