/**
 * Tests for the per-model fast-mode tracker.
 *
 * The behavior that matters here is the one that was broken: a request for a
 * model that can't do fast tier must not clear the badge for a model that
 * can. In production that's auto-mode's per-tool-call `claude-sonnet-5`
 * classifier (and any concurrent agent on another model) stomping an Opus
 * agent's badge between turns.
 */
import { describe, expect, it } from "vitest";

import {
  FastModeTracker,
  normalizeFastModeModelId,
  parseFastModePayload,
} from "../fast-mode.js";

describe("normalizeFastModeModelId", () => {
  it("strips the provider prefix and lowercases", () => {
    expect(normalizeFastModeModelId("hawk/claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeFastModeModelId("Claude-Opus-5")).toBe("claude-opus-5");
    expect(normalizeFastModeModelId("  hawk/Claude-Opus-5  ")).toBe("claude-opus-5");
  });

  it("returns null for unusable ids", () => {
    expect(normalizeFastModeModelId(undefined)).toBeNull();
    expect(normalizeFastModeModelId(null)).toBeNull();
    expect(normalizeFastModeModelId(42)).toBeNull();
    expect(normalizeFastModeModelId("")).toBeNull();
    expect(normalizeFastModeModelId("   ")).toBeNull();
    expect(normalizeFastModeModelId("hawk/")).toBeNull();
  });
});

describe("parseFastModePayload", () => {
  it("keeps a well-formed payload", () => {
    expect(parseFastModePayload({ intent: true, actual: "on", model: "claude-opus-5" })).toEqual({
      intent: true,
      actual: "on",
      model: "claude-opus-5",
    });
  });

  it("coerces intent and drops unknown actual / non-string model", () => {
    expect(parseFastModePayload({ intent: 1, actual: "bogus", model: 42 })).toEqual({
      intent: true,
    });
  });

  it("accepts each valid actual", () => {
    for (const actual of ["on", "off", "cooldown"] as const) {
      expect(parseFastModePayload({ intent: true, actual })).toEqual({ intent: true, actual });
    }
  });

  it("rejects non-objects", () => {
    expect(parseFastModePayload("nope")).toBeNull();
    expect(parseFastModePayload(null)).toBeNull();
    expect(parseFastModePayload(undefined)).toBeNull();
  });
});

describe("FastModeTracker", () => {
  it("starts empty", () => {
    const tracker = new FastModeTracker();
    expect(tracker.isEmpty()).toBe(true);
    expect(tracker.snapshot()).toEqual({ global: null, byModel: {} });
    expect(tracker.stateFor("hawk/claude-opus-5")).toBeNull();
  });

  it("ignores payloads that aren't fast-mode states", () => {
    const tracker = new FastModeTracker();
    expect(tracker.apply("nope")).toBeNull();
    expect(tracker.apply(null)).toBeNull();
    expect(tracker.isEmpty()).toBe(true);
  });

  it("keys per-model readings by bare model id", () => {
    const tracker = new FastModeTracker();
    const applied = tracker.apply({ intent: true, actual: "on", model: "claude-opus-5" });
    expect(applied?.state).toEqual({ intent: true, actual: "on", model: "claude-opus-5" });
    expect(applied?.snapshot).toEqual({
      global: null,
      byModel: { "claude-opus-5": { intent: true, actual: "on", model: "claude-opus-5" } },
    });
    // Provider-qualified lookups resolve to the same entry.
    expect(tracker.stateFor("hawk/claude-opus-5")).toEqual({
      intent: true,
      actual: "on",
      model: "claude-opus-5",
    });
  });

  it("does not let a non-fast model clear another model's badge", () => {
    const tracker = new FastModeTracker();
    tracker.apply({ intent: true, actual: "on", model: "claude-opus-5" });
    // auto-mode's classifier: fast mode is ON, but sonnet can't do fast tier,
    // so the provider reports intent:false for it. This used to blank the
    // badge for every agent.
    tracker.apply({ intent: false, model: "claude-sonnet-5" });

    expect(tracker.stateFor("hawk/claude-opus-5")).toEqual({
      intent: true,
      actual: "on",
      model: "claude-opus-5",
    });
    expect(tracker.stateFor("hawk/claude-sonnet-5")).toEqual({
      intent: false,
      model: "claude-sonnet-5",
    });
  });

  it("tracks concurrent agents on different models independently", () => {
    const tracker = new FastModeTracker();
    tracker.apply({ intent: true, actual: "on", model: "claude-opus-5" });
    tracker.apply({ intent: true, actual: "on", model: "claude-opus-4-8" });
    tracker.apply({ intent: false, model: "gpt-5.6-sol" });

    expect(Object.keys(tracker.snapshot().byModel).sort()).toEqual([
      "claude-opus-4-8",
      "claude-opus-5",
      "gpt-5.6-sol",
    ]);
    expect(tracker.stateFor("claude-opus-5")?.actual).toBe("on");
    expect(tracker.stateFor("claude-opus-4-8")?.actual).toBe("on");
  });

  it("overwrites a model's previous reading", () => {
    const tracker = new FastModeTracker();
    tracker.apply({ intent: true, actual: "on", model: "claude-opus-5" });
    tracker.apply({ intent: true, actual: "cooldown", model: "claude-opus-5" });
    expect(tracker.stateFor("claude-opus-5")?.actual).toBe("cooldown");
    expect(Object.keys(tracker.snapshot().byModel)).toEqual(["claude-opus-5"]);
  });

  it("treats a model-less reading as the provider-wide toggle and invalidates per-model state", () => {
    const tracker = new FastModeTracker();
    tracker.apply({ intent: true, actual: "on", model: "claude-opus-5" });

    // `/fast off` — the toggle is provider-wide, so the stale "on" we hold for
    // Opus must not keep the badge lit until its next turn.
    const applied = tracker.apply({ intent: false });
    expect(applied?.snapshot).toEqual({ global: { intent: false }, byModel: {} });
    expect(tracker.stateFor("claude-opus-5")).toEqual({ intent: false });
  });

  it("falls back to the toggle for a model that hasn't run a turn yet", () => {
    const tracker = new FastModeTracker();
    // `/fast on`, before any request has gone out.
    tracker.apply({ intent: true });
    expect(tracker.stateFor("hawk/claude-opus-5")).toEqual({ intent: true });
    // First Opus turn refines it; the toggle stays as the fallback for others.
    tracker.apply({ intent: true, actual: "on", model: "claude-opus-5" });
    expect(tracker.stateFor("claude-opus-5")?.actual).toBe("on");
    expect(tracker.stateFor("claude-haiku-5")).toEqual({ intent: true });
  });
});
