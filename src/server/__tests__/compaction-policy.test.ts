/**
 * Tests for the fraction-of-context-window auto-compaction policy.
 *
 * The behaviour that matters: with no configuration nothing changes (pi's
 * own reserve-based trigger stays in charge), and with a configured fraction
 * the derived `reserveTokens` makes pi's `shouldCompact()` — which is
 * `contextTokens > contextWindow - reserveTokens` — fire at exactly that
 * fraction of the window.
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  applyCompactionSettings,
  compactionSettingsFor,
  INERT_POLICY,
  PI_DEFAULT_KEEP_RECENT_TOKENS,
  PI_DEFAULT_RESERVE_TOKENS,
  policyAppliesTo,
  resolveCompactionPolicy,
} from "../compaction-policy.js";

/** Pi's trigger, reproduced so the tests assert the thing we actually care
 *  about rather than the intermediate `reserveTokens` arithmetic. */
function triggersAt(reserveTokens: number, contextWindow: number): number {
  return contextWindow - reserveTokens;
}

describe("resolveCompactionPolicy", () => {
  it("is inert with no config and no env", () => {
    const { policy, warnings } = resolveCompactionPolicy(undefined, {});
    expect(policy).toEqual(INERT_POLICY);
    expect(warnings).toEqual([]);
  });

  it("reads a fraction and model globs from config", () => {
    const { policy } = resolveCompactionPolicy(
      { auto_compact_at: 0.4, auto_compact_models: ["hawk/claude-opus-*"] },
      {},
    );
    expect(policy.fraction).toBe(0.4);
    expect(policy.models).toEqual(["hawk/claude-opus-*"]);
  });

  it("lets env override config", () => {
    const { policy } = resolveCompactionPolicy(
      { auto_compact_at: 0.4, auto_compact_models: ["a/*"] },
      { PIROUETTE_AUTO_COMPACT_AT: "0.6", PIROUETTE_AUTO_COMPACT_MODELS: "b/*, c/*" },
    );
    expect(policy.fraction).toBe(0.6);
    expect(policy.models).toEqual(["b/*", "c/*"]);
  });

  it("accepts a percentage and warns about out-of-range values", () => {
    expect(resolveCompactionPolicy({ auto_compact_at: 40 }, {}).policy.fraction).toBe(0.4);

    const { policy, warnings } = resolveCompactionPolicy({ auto_compact_at: 0.99 }, {});
    expect(policy.fraction).toBe(0.95);
    expect(warnings).toHaveLength(1);
  });

  it("ignores garbage instead of throwing", () => {
    const { policy, warnings } = resolveCompactionPolicy({ auto_compact_at: "soon" }, {});
    expect(policy.fraction).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});

describe("policyAppliesTo", () => {
  const policy = {
    fraction: 0.4,
    models: ["hawk/claude-opus-*", "claude-fable-*"],
    keepRecentTokens: 0,
  };

  it("matches on the qualified id and on the bare id", () => {
    expect(policyAppliesTo(policy, { provider: "hawk", id: "claude-opus-5" })).toBe(true);
    expect(policyAppliesTo(policy, { provider: "other", id: "claude-fable-5" })).toBe(true);
  });

  it("is case-insensitive and does not treat patterns as regexes", () => {
    expect(policyAppliesTo(policy, { provider: "HAWK", id: "Claude-Opus-5" })).toBe(true);
    expect(
      policyAppliesTo(
        { fraction: 0.4, models: ["a.b"], keepRecentTokens: 0 },
        { provider: "a", id: "b" },
      ),
    ).toBe(false);
  });

  it("skips models outside the list", () => {
    expect(policyAppliesTo(policy, { provider: "hawk", id: "gpt-5.2" })).toBe(false);
  });

  it("applies to every model when the list is empty", () => {
    expect(
      policyAppliesTo({ fraction: 0.4, models: [], keepRecentTokens: 0 }, { id: "anything" }),
    ).toBe(true);
  });

  it("never applies without a fraction", () => {
    expect(policyAppliesTo({ fraction: 0, models: [], keepRecentTokens: 0 }, { id: "x" })).toBe(
      false,
    );
  });
});

describe("applyCompactionSettings", () => {
  const settings = { enabled: true as const, reserveTokens: 600_000, keepRecentTokens: 100_000 };

  it("is visible through the manager pi's session reads from", () => {
    const manager = SettingsManager.inMemory({ compaction: { enabled: true } });
    applyCompactionSettings(manager, settings);
    expect(manager.getCompactionSettings()).toEqual(settings);
  });

  it("survives an unrelated setter's internal save()", () => {
    // Pi calls save() from setDefaultModelAndProvider / setDefaultThinkingLevel,
    // which rebuilds the merged settings from the global layer. An
    // applyOverrides-only patch would vanish here, quietly restoring the
    // 16k default reserve mid-session.
    const manager = SettingsManager.inMemory({ compaction: { enabled: true } });
    applyCompactionSettings(manager, settings);
    manager.setDefaultThinkingLevel("high");
    manager.setDefaultModelAndProvider("hawk", "claude-opus-5");
    expect(manager.getCompactionSettings()).toEqual(settings);
  });

  it("still patches the merged view if the global layer is unreachable", () => {
    let applied: unknown = null;
    const stub = {
      applyOverrides: (o: unknown) => {
        applied = o;
      },
      getCompactionSettings: () => settings,
    };
    applyCompactionSettings(stub, settings);
    expect(applied).toEqual({ compaction: settings });
  });
});

describe("compactionSettingsFor", () => {
  const policy = { fraction: 0.4, models: ["hawk/claude-opus-*"], keepRecentTokens: 0 };

  it("keeps pi's defaults for models the policy doesn't cover", () => {
    const settings = compactionSettingsFor(policy, {
      provider: "hawk",
      id: "gpt-5.2",
      contextWindow: 400_000,
    });
    expect(settings).toEqual({
      enabled: true,
      reserveTokens: PI_DEFAULT_RESERVE_TOKENS,
      keepRecentTokens: PI_DEFAULT_KEEP_RECENT_TOKENS,
      triggerTokens: null,
    });
  });

  it("triggers at the configured fraction of the window", () => {
    const settings = compactionSettingsFor(policy, {
      provider: "hawk",
      id: "claude-opus-5",
      contextWindow: 1_000_000,
    });
    expect(settings.triggerTokens).toBe(400_000);
    expect(triggersAt(settings.reserveTokens, 1_000_000)).toBe(400_000);
  });

  it("keeps a quarter of the trigger budget verbatim by default", () => {
    const settings = compactionSettingsFor(policy, {
      provider: "hawk",
      id: "claude-opus-5",
      contextWindow: 1_000_000,
    });
    expect(settings.keepRecentTokens).toBe(100_000);
  });

  it("honours an explicit keep_recent_tokens but never lets it reach the trigger", () => {
    const pinned = { ...policy, keepRecentTokens: 50_000 };
    expect(
      compactionSettingsFor(pinned, {
        provider: "hawk",
        id: "claude-opus-5",
        contextWindow: 1_000_000,
      }).keepRecentTokens,
    ).toBe(50_000);

    // 40% of 200k = 80k trigger; a pinned 50k would leave almost nothing to
    // summarize, so it is capped at half the trigger.
    expect(
      compactionSettingsFor(pinned, {
        provider: "hawk",
        id: "claude-opus-4-5",
        contextWindow: 200_000,
      }).keepRecentTokens,
    ).toBe(40_000);
  });

  it("falls back to pi's defaults for a model with no usable window", () => {
    expect(
      compactionSettingsFor(policy, { provider: "hawk", id: "claude-opus-5", contextWindow: 0 })
        .triggerTokens,
    ).toBeNull();
    expect(compactionSettingsFor(policy, null).triggerTokens).toBeNull();
  });

  it("declines to act when the fraction leaves less headroom than pi's own reserve", () => {
    // 95% of a 32k window leaves 1.6k of reserve — pi would compact at
    // essentially the same point, so we stay out of the way.
    const aggressive = { fraction: 0.95, models: [], keepRecentTokens: 0 };
    const settings = compactionSettingsFor(aggressive, { id: "tiny", contextWindow: 32_000 });
    expect(settings.triggerTokens).toBeNull();
    expect(settings.reserveTokens).toBe(PI_DEFAULT_RESERVE_TOKENS);
  });
});
