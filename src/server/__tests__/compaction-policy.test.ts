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
  type CompactionConfig,
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

describe("per-model compaction rules", () => {
  const rules = [
    { models: ["demo/claude-*"], auto_compact_at: 0.4 },
    { models: ["demo/gpt-*"], auto_compact_at: 0.8 },
  ];
  const claude = { provider: "demo", id: "claude-large", contextWindow: 1_000_000 };
  const gpt = { provider: "demo", id: "gpt-medium", contextWindow: 272_000 };

  it("supports different thresholds without a global fraction", () => {
    const { policy, warnings } = resolveCompactionPolicy({ rules }, {});
    expect(warnings).toEqual([]);
    expect(policy.fraction).toBe(0);
    expect(policyAppliesTo(policy, claude)).toBe(true);
    expect(policyAppliesTo(policy, gpt)).toBe(true);
    expect(compactionSettingsFor(policy, claude)).toEqual({
      enabled: true, triggerTokens: 400_000, reserveTokens: 600_000, keepRecentTokens: 100_000,
    });
    expect(compactionSettingsFor(policy, gpt)).toEqual({
      enabled: true, triggerTokens: 217_600, reserveTokens: 54_400, keepRecentTokens: 54_400,
    });
    expect(compactionSettingsFor(policy, { id: "unmatched", contextWindow: 272_000 }).reserveTokens)
      .toBe(PI_DEFAULT_RESERVE_TOKENS);
  });

  it("uses the first matching rule, including a zero that selects pi's defaults", () => {
    const { policy } = resolveCompactionPolicy({
      auto_compact_at: 0.6,
      rules: [
        { models: "demo/gpt-medium", auto_compact_at: 0 },
        ...rules,
        { models: "*", auto_compact_at: 0.7 },
      ],
    }, {});
    expect(policyAppliesTo(policy, gpt)).toBe(false);
    expect(compactionSettingsFor(policy, gpt).reserveTokens).toBe(PI_DEFAULT_RESERVE_TOKENS);
    expect(compactionSettingsFor(policy, claude).triggerTokens).toBe(400_000);
    expect(compactionSettingsFor(policy, { id: "other", contextWindow: 1_000_000 }).triggerTokens).toBe(700_000);
  });

  it("checks rules before the fallback model filter and retains the fallback for other models", () => {
    const { policy } = resolveCompactionPolicy({
      auto_compact_at: 0.5, auto_compact_models: ["claude-*"], rules: [rules[1]],
    }, {});
    expect(compactionSettingsFor(policy, gpt).triggerTokens).toBe(217_600);
    expect(compactionSettingsFor(policy, claude).triggerTokens).toBe(500_000);
    expect(policyAppliesTo(policy, { id: "other" })).toBe(false);
  });

  it("matches bare and qualified globs case-insensitively without regex semantics", () => {
    const { policy } = resolveCompactionPolicy({ rules: [
      { models: ["GPT-*", "a.b"], auto_compact_at: 0.8 },
    ] }, {});
    expect(policyAppliesTo(policy, gpt)).toBe(true);
    expect(policyAppliesTo(policy, { provider: "other", id: "gpt-test" })).toBe(true);
    expect(policyAppliesTo(policy, { provider: "a", id: "b" })).toBe(false);
  });

  it("applies the same percentage and clamp validation to rules", () => {
    const { policy, warnings } = resolveCompactionPolicy({ rules: [
      { models: "one", auto_compact_at: 80 },
      { models: "two", auto_compact_at: 0.99 },
      { models: "three", auto_compact_at: 0.01 },
    ] }, {});
    expect(policy.rules?.map((rule) => rule.fraction)).toEqual([0.8, 0.95, 0.05]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("rules[1].auto_compact_at");
  });

  it("ignores malformed rules without discarding good siblings", () => {
    const config = { rules: [
      null, [], "invalid", { models: [], auto_compact_at: 0.8 },
      { models: [null], auto_compact_at: 0.8 }, { models: ["gpt-*"], auto_compact_at: "soon" },
      { models: ["gpt-*"] }, ...rules,
    ] } as unknown as CompactionConfig;
    const { policy, warnings } = resolveCompactionPolicy(config, {});
    expect(policy.rules).toHaveLength(2);
    expect(warnings).toHaveLength(7);
    expect(compactionSettingsFor(policy, gpt).triggerTokens).toBe(217_600);
  });

  it("warns about a non-array config instead of failing startup", () => {
    const { policy, warnings } = resolveCompactionPolicy({ rules: {} } as CompactionConfig, {});
    expect(policy).toEqual(INERT_POLICY);
    expect(warnings).toEqual(["ignoring compaction rules: expected an array"]);
  });

  it("lets JSON environment rules replace or clear configured rules", () => {
    const env = { PIROUETTE_AUTO_COMPACT_RULES: JSON.stringify([{ models: "gpt-*", auto_compact_at: 0.7 }]) };
    const { policy } = resolveCompactionPolicy({ rules }, env);
    expect(compactionSettingsFor(policy, gpt).triggerTokens).toBe(190_400);
    expect(policyAppliesTo(policy, claude)).toBe(false);
    expect(resolveCompactionPolicy({ rules }, { PIROUETTE_AUTO_COMPACT_RULES: "[]" }).policy.rules).toEqual([]);
  });

  it.each(["not JSON", "null", "{}"])("ignores malformed environment rules (%s)", (raw) => {
    const { policy, warnings } = resolveCompactionPolicy({ rules }, { PIROUETTE_AUTO_COMPACT_RULES: raw });
    expect(compactionSettingsFor(policy, gpt).triggerTokens).toBe(217_600);
    expect(warnings).toHaveLength(1);
  });

  it("keeps rule overrides when environment changes the fallback", () => {
    const { policy } = resolveCompactionPolicy({ rules }, { PIROUETTE_AUTO_COMPACT_AT: "0.6" });
    expect(compactionSettingsFor(policy, gpt).triggerTokens).toBe(217_600);
    expect(compactionSettingsFor(policy, { id: "other", contextWindow: 1_000_000 }).triggerTokens).toBe(600_000);
  });

  it("recomputes both budgets on model switches and survives settings saves", () => {
    const { policy } = resolveCompactionPolicy({ rules }, {});
    const manager = SettingsManager.inMemory({ compaction: { enabled: true } });
    for (const model of [claude, gpt, claude]) {
      const settings = compactionSettingsFor(policy, model);
      applyCompactionSettings(manager, settings);
      manager.setDefaultModelAndProvider(model.provider, model.id);
      manager.setDefaultThinkingLevel("high");
      expect(manager.getCompactionSettings().reserveTokens).toBe(settings.reserveTokens);
      expect(manager.getCompactionSettings().keepRecentTokens).toBe(settings.keepRecentTokens);
    }
  });

  it("still respects keep-recent overrides and minimum reserve guardrails", () => {
    const { policy } = resolveCompactionPolicy({ rules, keep_recent_tokens: 20000 }, {});
    expect(compactionSettingsFor(policy, gpt).keepRecentTokens).toBe(20000);
    expect(compactionSettingsFor(policy, { ...gpt, contextWindow: 32000 }).reserveTokens).toBe(PI_DEFAULT_RESERVE_TOKENS);
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
