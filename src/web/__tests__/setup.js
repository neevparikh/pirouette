// Inject `marked` and `DOMPurify` into globalThis before tests run.
// This mirrors the CDN globals the browser provides, so render.js's
// `globalThis.marked` / `globalThis.DOMPurify` checks resolve correctly.

import * as marked from "marked";
import katex from "katex";
import DOMPurify from "isomorphic-dompurify";

globalThis.marked = marked;
globalThis.DOMPurify = DOMPurify;
globalThis.katex = katex;
