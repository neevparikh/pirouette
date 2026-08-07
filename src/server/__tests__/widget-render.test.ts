/**
 * Unit tests for the extension-widget renderer.
 *
 * The interesting property is the round trip: a widget component styles
 * its text with `theme.fg("success", …)` in a terminal-shaped API, and
 * the dashboard must receive the *name* "success" — not whatever RGB the
 * theme happened to hold — so it can paint with the user's palette.
 */

import { describe, expect, it } from "vitest";

import { parseAnsiSpans, renderExtensionWidget } from "../widget-render.js";

/** Minimal stand-in for what a widget factory receives + returns. */
type Factory = Parameters<typeof renderExtensionWidget>[1];

function factory(render: (theme: FakeTheme, width: number) => string[]): Factory {
  return ((_tui: never, theme: FakeTheme) => ({
    render: (width: number) => render(theme, width),
  })) as Factory;
}

interface FakeTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
}

describe("renderExtensionWidget", () => {
  it("returns null when the widget is cleared", () => {
    expect(renderExtensionWidget("todo-list", undefined)).toBeNull();
  });

  it("passes plain string lines through with no styling", () => {
    const widget = renderExtensionWidget("plain", ["hello", "world"]);
    expect(widget).toEqual({
      key: "plain",
      placement: "aboveEditor",
      lines: [[{ text: "hello" }], [{ text: "world" }]],
    });
  });

  it("maps theme colors back to their semantic names", () => {
    const widget = renderExtensionWidget(
      "todo-list",
      factory((theme) => [
        theme.fg("accent", " Todo List ") + theme.fg("muted", "— 1/2 completed"),
      ]),
    );
    expect(widget?.lines[0]).toEqual([
      { text: " Todo List ", color: "accent" },
      { text: "— 1/2 completed", color: "muted" },
    ]);
  });

  it("carries text attributes even though chalk is disabled off-TTY", () => {
    const widget = renderExtensionWidget(
      "todo-list",
      factory((theme) => [
        `✓ ${theme.fg("dim", theme.strikethrough("ship it"))}`,
        theme.bold("header"),
      ]),
    );
    expect(widget?.lines[0]).toEqual([
      { text: "✓ " },
      { text: "ship it", color: "dim", strikethrough: true },
    ]);
    expect(widget?.lines[1]).toEqual([{ text: "header", bold: true }]);
  });

  it("maps background colors too", () => {
    const widget = renderExtensionWidget(
      "bg",
      factory((theme) => [theme.bg("selectedBg", "selected")]),
    );
    expect(widget?.lines[0]).toEqual([{ text: "selected", bg: "selectedBg" }]);
  });

  it("renders at a fixed column width", () => {
    const widget = renderExtensionWidget(
      "width",
      factory((_theme, width) => [`w=${width}`]),
    );
    expect(widget?.lines[0]).toEqual([{ text: "w=100" }]);
  });

  it("honors the requested placement", () => {
    const widget = renderExtensionWidget("plain", ["x"], "belowEditor");
    expect(widget?.placement).toBe("belowEditor");
  });

  it("drops a widget whose factory throws instead of failing the turn", () => {
    const boom = (() => {
      throw new Error("no TUI for you");
    }) as Factory;
    expect(renderExtensionWidget("boom", boom)).toBeNull();
  });

  it("drops a widget that renders nothing visible", () => {
    expect(renderExtensionWidget("blank", ["", "   "])).toBeNull();
  });

  it("caps runaway widgets", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    expect(renderExtensionWidget("long", lines)?.lines).toHaveLength(200);
  });
});

describe("parseAnsiSpans", () => {
  it("keeps unstyled text as a single span", () => {
    expect(parseAnsiSpans("just text")).toEqual([{ text: "just text" }]);
  });

  it("merges adjacent runs with identical styling", () => {
    // Two separate `fg` calls with the same color produce two escape
    // pairs but should render as one span.
    const line = "\x1b[38;2;1;0;1ma\x1b[39m\x1b[38;2;1;0;1mb\x1b[39m";
    expect(parseAnsiSpans(line)).toEqual([{ text: "ab", color: "accent" }]);
  });

  it("resets everything on ESC[0m", () => {
    const line = "\x1b[1m\x1b[38;2;1;0;5mbold-success\x1b[0mplain";
    expect(parseAnsiSpans(line)).toEqual([
      { text: "bold-success", color: "success", bold: true },
      { text: "plain" },
    ]);
  });

  it("keeps the text of colors it can't name", () => {
    // A widget that wrote raw ANSI itself: no sentinel, so no semantic
    // name — but the text must survive.
    expect(parseAnsiSpans("\x1b[38;2;255;0;0mred\x1b[39m")).toEqual([{ text: "red" }]);
    expect(parseAnsiSpans("\x1b[38;5;42m256color\x1b[39m")).toEqual([{ text: "256color" }]);
  });

  it("strips non-SGR escapes and control characters", () => {
    expect(parseAnsiSpans("a\x1b[2Kb\x1b]0;title\x07c\x00d")).toEqual([{ text: "abcd" }]);
  });
});
