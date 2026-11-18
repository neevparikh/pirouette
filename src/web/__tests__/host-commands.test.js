import { describe, expect, it } from "vitest";

import { describeRun, linkifyOutput } from "../host-commands.js";

describe("linkifyOutput", () => {
  it("returns plain text untouched", () => {
    expect(linkifyOutput("no links here\n")).toEqual([{ text: "no links here\n" }]);
    expect(linkifyOutput("")).toEqual([]);
  });

  it("turns http(s) URLs into link segments", () => {
    expect(linkifyOutput("Open https://example.com/login?code=AB-12&x=1 to log in\n")).toEqual([
      { text: "Open " },
      { url: "https://example.com/login?code=AB-12&x=1" },
      { text: " to log in\n" },
    ]);
  });

  it("leaves sentence punctuation and unbalanced brackets out of the link", () => {
    expect(linkifyOutput("See http://a.test/x.")).toEqual([{ text: "See " }, { url: "http://a.test/x" }, { text: "." }]);
    expect(linkifyOutput("(see https://a.test/x)")).toEqual([
      { text: "(see " },
      { url: "https://a.test/x" },
      { text: ")" },
    ]);
    expect(linkifyOutput("https://a.test/wiki/A_(b)")).toEqual([{ url: "https://a.test/wiki/A_(b)" }]);
  });

  it("does not link other schemes", () => {
    expect(linkifyOutput("javascript:alert(1) file:///etc/passwd")).toEqual([
      { text: "javascript:alert(1) file:///etc/passwd" },
    ]);
  });
});

describe("describeRun", () => {
  it("summarises each state", () => {
    expect(describeRun({ state: "idle" })).toEqual({ text: "not run yet", tone: "idle" });
    expect(describeRun({ state: "running" })).toEqual({ text: "running…", tone: "running" });
    expect(describeRun({ state: "exited", exitCode: 0 })).toEqual({ text: "finished", tone: "ok" });
    expect(describeRun({ state: "exited", exitCode: 3 })).toEqual({ text: "failed (exit 3)", tone: "error" });
    expect(describeRun({ state: "exited", exitCode: null })).toEqual({ text: "failed", tone: "error" });
    expect(describeRun({ state: "exited", exitCode: null, stopped: true })).toEqual({ text: "stopped", tone: "error" });
    expect(describeRun({ state: "exited", exitCode: null, timedOut: true })).toEqual({ text: "timed out", tone: "error" });
  });
});
