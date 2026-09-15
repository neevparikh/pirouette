// Math needs browser flow layout: a fraction isn't a fixed number of
// monospace cells. Messages with math use the existing .md styles; other
// messages keep the terminal renderer, including its box-drawing tables.
import { configureMarked, escHtml } from "./render.js";

// Scan before Markdown unescapes \( and \[ or treats TeX underscores as
// emphasis. Marked's code/link tokenizers still own code and destinations.
function readMath(src, block = false) {
  const leading = block ? /^( {0,3})/.exec(src)[0].length : 0;
  const input = src.slice(leading);
  const open = ["\\[", "$$", "\\(", "$"].find((d) => input.startsWith(d));
  if (!open || (block && open !== "\\[" && open !== "$$")) return;
  const close = open === "\\[" ? "\\]" : open === "\\(" ? "\\)" : open;
  const display = open === "\\[" || open === "$$";
  if (open === "$" && /\s/.test(input[1] || " ")) return;

  let braces = 0;
  for (let i = open.length; i < input.length; i++) {
    const ch = input[i];
    // Dollar inline math cannot cross a newline (or eat a later price).
    if (open === "$" && ch === "\n") return;
    if (braces === 0 && input.startsWith(close, i)) {
      if (open === "$" && (/\s/.test(input[i - 1]) || /[\d$]/.test(input[i + 1] || ""))) return;
      const end = leading + i + close.length;
      if (block && !/^(?:[^\S\n]*(?:\n|$))/.test(src.slice(end))) return;
      return { raw: src.slice(0, end), text: input.slice(open.length, i), display, complete: true };
    }
    if (ch === "\\") i++; // escaped dollar/brace/backslash, not a delimiter
    else if (ch === "{") braces++;
    else if (ch === "}") braces = Math.max(0, braces - 1);
  }
  // Keep partially streamed TeX literal, including its backslashes. A lone
  // dollar is ordinary prose, so it doesn't select the math layout.
  if (open !== "$") {
    return { raw: src, text: input.slice(open.length), display, complete: false };
  }
}

const formulaCache = new Map();
let cachedKatex;
function renderFormula(token) {
  const katex = globalThis.katex;
  const fallback = () => `<code class="math-fallback">${escHtml(token.raw)}</code>`;
  if (!token.complete || !katex) return fallback();
  if (cachedKatex !== katex) {
    formulaCache.clear();
    cachedKatex = katex;
  }
  const key = `${token.display}:${token.text}`;
  if (formulaCache.has(key)) return formulaCache.get(key);
  try {
    const html = katex.renderToString(token.text, {
      displayMode: token.display,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 20,
    });
    // Completed equations recur on every streaming delta. Bound retention
    // across long chats, and never share TeX macro state between equations.
    if (formulaCache.size >= 128) formulaCache.delete(formulaCache.keys().next().value);
    formulaCache.set(key, html);
    return html;
  } catch {
    // Unsupported/malformed TeX must not break the surrounding message.
    return fallback();
  }
}

let markedGlobal;
let mathMarked;
function getMathMarked() {
  const marked = globalThis.marked;
  if (!marked?.Marked) return null;
  if (markedGlobal === marked) return mathMarked;
  markedGlobal = marked;
  mathMarked = new marked.Marked();
  configureMarked(mathMarked);
  mathMarked.use({
    extensions: [false, true].map((block) => ({
      name: block ? "mathBlock" : "mathInline",
      level: block ? "block" : "inline",
      start(src) {
        const match = block
          ? /(?:^|\n) {0,3}(?:\\\[|\$\$)/.exec(src)
          : /\\[([]|\$/.exec(src);
        return match?.index;
      },
      tokenizer(src) {
        const math = readMath(src, block);
        if (math) return { type: block ? "mathBlock" : "mathInline", ...math };
      },
      renderer(token) {
        const html = renderFormula(token);
        return block ? `<div class="math-block">${html}</div>\n` : html;
      },
    })),
  });
  return mathMarked;
}

/** Return sanitized flow-layout HTML, or null when there is no math.
 *  A tokenizer (not a regexp substitution) keeps code and URLs literal. */
export function renderMathMarkdown(text) {
  if (!text || !/\\[([]|\$/.test(text) || !globalThis.DOMPurify) return null;
  const marked = getMathMarked();
  if (!marked) return null;
  try {
    const tokens = marked.lexer(text);
    let hasMath = false;
    marked.walkTokens(tokens, (token) => {
      if (token.type === "mathInline" || token.type === "mathBlock") hasMath = true;
    });
    if (!hasMath) return null;
    return globalThis.DOMPurify.sanitize(marked.parser(tokens), {
      ADD_ATTR: ["target"],
      // KaTeX includes the source in a MathML annotation for accessibility
      // and copy tools. Without these, sanitization unwraps it into visible
      // MathML text. Do not enable annotation-xml (an HTML integration point).
      ADD_TAGS: ["semantics", "annotation"],
    });
  } catch {
    return escHtml(text);
  }
}
