/** Render pi extension widgets (`ctx.ui.setWidget`) into a JSON-safe,
 *  theme-agnostic shape the dashboard can draw.
 *
 *  # The problem
 *
 *  `ExtensionUIContext.setWidget` has two flavors:
 *
 *    setWidget(key, lines: string[], opts?)
 *    setWidget(key, factory: (tui: TUI, theme: Theme) => Component, opts?)
 *
 *  Pi's RPC mode supports only the first and silently drops the second —
 *  but the factory form is what widget-shipping extensions actually use
 *  (they want colors, and the only way to get a `Theme` is the factory
 *  argument). A dashboard that ignores factories shows nothing for them.
 *
 *  # The approach
 *
 *  We call the factory with a stub TUI and a *sentinel theme*: a real
 *  `Theme` whose every semantic color is a unique, otherwise-impossible
 *  RGB triple (`r=1` for foregrounds, `r=2` for backgrounds, `b` = the
 *  color's index). The component renders to ANSI strings as it would in
 *  a terminal; we then parse those strings back into spans and map each
 *  sentinel triple to the semantic color name that produced it
 *  (`accent`, `success`, `dim`, …).
 *
 *  The browser therefore receives `{ text, color: "success" }` rather
 *  than a hardcoded RGB, and paints it with the base16 palette of
 *  whatever theme the user picked. Text attributes (bold / italic /
 *  underline / strikethrough) come through as booleans.
 *
 *  `Theme.bold()` and friends delegate to chalk, which emits nothing
 *  when stdout isn't a TTY — which is always, for a server whose output
 *  is a log file. `SentinelTheme` overrides them to write the SGR codes
 *  unconditionally so attributes survive.
 */

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

import type { AgentWidget, WidgetPlacement, WidgetSpan } from "./types.js";

/** Every `ThemeColor` the SDK defines, in a fixed order. The index into
 *  this array is what the sentinel RGB encodes, so entries must only
 *  ever be appended — but since the list mirrors the SDK's union, a
 *  reorder is caught by the `satisfies` check below. */
const FG_COLORS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
] as const satisfies readonly ThemeColor[];

/** Backgrounds, same encoding with a different marker byte. */
const BG_COLORS = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;

/** Marker value in the red channel. Real themes never use these (they'd
 *  be indistinguishable from black), and even if one did the worst case
 *  is a mislabeled color on a widget. */
const FG_MARKER = 1;
const BG_MARKER = 2;

function sentinelHex(marker: number, index: number): string {
  // `#RRGGBB` with GG always 00 and BB the 1-based palette index.
  const rr = marker.toString(16).padStart(2, "0");
  const bb = (index + 1).toString(16).padStart(2, "0");
  return `#${rr}00${bb}`;
}

/** A `Theme` that encodes semantic color names instead of real colors,
 *  and emits text attributes without asking chalk's opinion. */
class SentinelTheme extends Theme {
  constructor() {
    const fg = Object.fromEntries(
      FG_COLORS.map((name, i) => [name, sentinelHex(FG_MARKER, i)]),
    ) as Record<ThemeColor, string>;
    const bg = Object.fromEntries(
      BG_COLORS.map((name, i) => [name, sentinelHex(BG_MARKER, i)]),
    ) as Record<(typeof BG_COLORS)[number], string>;
    super(fg, bg, "truecolor", { name: "pirouette-sentinel" });
  }

  override bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  }
  override italic(text: string): string {
    return `\x1b[3m${text}\x1b[23m`;
  }
  override underline(text: string): string {
    return `\x1b[4m${text}\x1b[24m`;
  }
  override inverse(text: string): string {
    return `\x1b[7m${text}\x1b[27m`;
  }
  override strikethrough(text: string): string {
    return `\x1b[9m${text}\x1b[29m`;
  }
}

const sentinelTheme = new SentinelTheme();

/** Column count handed to `Component.render(width)`. Widgets wrap their
 *  own text to this, and the dashboard renders the result in a
 *  horizontally-scrollable monospace block, so it only needs to be wide
 *  enough that nothing wraps absurdly early. */
export const WIDGET_RENDER_COLUMNS = 100;

/** Hard caps so a runaway widget can't flood every connected browser. */
const MAX_WIDGET_LINES = 200;
const MAX_WIDGET_LINE_CHARS = 4000;

/** Widget factories take a `TUI`. Almost all of them ignore it; the ones
 *  that don't want to schedule a redraw, which we handle by re-rendering
 *  on the next `setWidget` call. A Proxy that answers every property
 *  with a no-op function keeps those calls from throwing without us
 *  having to model the TUI's (large, terminal-bound) surface. */
function stubTui(): never {
  const noop = () => undefined;
  return new Proxy(
    {},
    {
      get: (_t, prop) => (prop === "then" ? undefined : noop),
      set: () => true,
    },
  ) as never;
}

/** Widget content as pi hands it to us: literal lines, or a factory. */
export type WidgetContent =
  | string[]
  | ((tui: never, theme: Theme) => { render(width: number): string[] })
  | undefined;

/** Turn a `setWidget` payload into the shape broadcast to clients.
 *  Returns `null` when the widget is being cleared, when it renders
 *  empty, or when rendering it threw (a broken widget must never take
 *  down the agent's turn — the extension callback runs inline). */
export function renderExtensionWidget(
  key: string,
  content: WidgetContent,
  placement: WidgetPlacement = "aboveEditor",
): AgentWidget | null {
  if (content === undefined) return null;
  // `placement` reaches us straight from an extension, so don't trust it
  // to be one of the two values the dashboard knows how to place.
  const slot: WidgetPlacement = placement === "belowEditor" ? "belowEditor" : "aboveEditor";

  let rawLines: string[];
  if (Array.isArray(content)) {
    rawLines = content;
  } else if (typeof content === "function") {
    try {
      const component = content(stubTui(), sentinelTheme);
      rawLines = component.render(WIDGET_RENDER_COLUMNS);
    } catch (err) {
      console.warn(
        `[widget] failed to render widget "${key}": ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  } else {
    return null;
  }

  const lines = rawLines
    .slice(0, MAX_WIDGET_LINES)
    .map((line) =>
      parseAnsiSpans(String(line ?? "").slice(0, MAX_WIDGET_LINE_CHARS)),
    );

  // A widget whose every line is blank is indistinguishable from no
  // widget at all, and rendering it would leave an empty strip.
  if (lines.every((spans) => spans.every((s) => s.text.trim() === ""))) return null;

  return { key, placement: slot, lines };
}

/** SGR attribute codes we understand. Everything else is dropped. */
const ATTR_ON: Record<number, keyof WidgetSpan> = {
  1: "bold",
  3: "italic",
  4: "underline",
  9: "strikethrough",
};
const ATTR_OFF: Record<number, keyof WidgetSpan> = {
  22: "bold",
  23: "italic",
  24: "underline",
  29: "strikethrough",
};

interface SpanStyle {
  color?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI parsing
const ANSI_RE = /\x1b\[([0-9;]*)m/g;

/** Parse one ANSI-styled line into styled spans, mapping sentinel colors
 *  back to their semantic names. Exported for tests. */
export function parseAnsiSpans(line: string): WidgetSpan[] {
  const spans: WidgetSpan[] = [];
  let style: SpanStyle = {};
  let cursor = 0;

  const push = (text: string) => {
    if (!text) return;
    const prev = spans[spans.length - 1];
    const span: WidgetSpan = { text, ...style };
    // Merge runs that carry identical styling so the client renders one
    // `<span>` per visual run rather than one per escape sequence.
    if (prev && sameStyle(prev, span)) {
      prev.text += text;
      return;
    }
    spans.push(span);
  };

  ANSI_RE.lastIndex = 0;
  let match: RegExpExecArray | null = ANSI_RE.exec(line);
  while (match !== null) {
    push(line.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    style = applySgr(style, match[1]);
    match = ANSI_RE.exec(line);
  }
  push(line.slice(cursor));

  // Strip any escape sequences we didn't recognize (cursor movement,
  // OSC, …) so raw control bytes never reach the browser.
  for (const span of spans) span.text = stripControl(span.text);
  return spans.filter((s) => s.text.length > 0);
}

function sameStyle(a: WidgetSpan, b: WidgetSpan): boolean {
  return (
    a.color === b.color &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strikethrough === !!b.strikethrough
  );
}

/** Apply one SGR sequence's parameters to the running style. */
function applySgr(style: SpanStyle, params: string): SpanStyle {
  const next: SpanStyle = { ...style };
  // An empty parameter list (`ESC[m`) means reset, same as `ESC[0m`.
  const codes = (params === "" ? "0" : params).split(";").map((p) => Number(p || "0"));

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) {
      for (const k of Object.keys(next) as (keyof SpanStyle)[]) delete next[k];
      continue;
    }
    if (ATTR_ON[code]) {
      next[ATTR_ON[code] as "bold"] = true;
      continue;
    }
    if (ATTR_OFF[code]) {
      delete next[ATTR_OFF[code] as "bold"];
      continue;
    }
    if (code === 39) {
      delete next.color;
      continue;
    }
    if (code === 49) {
      delete next.bg;
      continue;
    }
    // 38/48 introduce an extended color: `;5;n` (256) or `;2;r;g;b`.
    if (code === 38 || code === 48) {
      const kind = codes[i + 1];
      if (kind === 5) {
        i += 2;
        // 256-color widgets exist but carry no semantics we can map, so
        // they render in the default text color.
        continue;
      }
      if (kind === 2) {
        const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]];
        i += 4;
        const name = semanticName(r, g, b);
        if (name) {
          if (code === 38) next.color = name;
          else next.bg = name;
        }
        continue;
      }
      continue;
    }
  }
  return next;
}

/** Decode a sentinel RGB triple back to the theme color that emitted it.
 *  Returns undefined for any color a widget wrote directly (raw ANSI in
 *  a `string[]` widget, say) — those lose their color rather than being
 *  pinned to an arbitrary palette entry. */
function semanticName(r: number, g: number, b: number): string | undefined {
  if (g !== 0) return undefined;
  if (r === FG_MARKER) return FG_COLORS[b - 1];
  if (r === BG_MARKER) return BG_COLORS[b - 1];
  return undefined;
}

// Anything escape-shaped that isn't an SGR sequence: CSI (cursor moves,
// erases), OSC (title / hyperlink), and lone two-byte escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control stripping
const ESC_SEQ_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]?/g;
// Remaining C0 controls, minus tab (\x09) and newline (\x0a), which a
// widget line can legitimately contain.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control stripping
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

function stripControl(text: string): string {
  return text.replace(ESC_SEQ_RE, "").replace(CONTROL_RE, "");
}
