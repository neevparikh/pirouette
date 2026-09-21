/** Auto-compaction policy: compact at a fraction of the context window.
 *
 *  Pi's built-in auto-compaction is a safety net, not a strategy. It fires
 *  when the context is nearly full (`contextTokens > contextWindow -
 *  reserveTokens`, default reserve 16k), which on a million-token model
 *  means the agent has already spent a very long time dragging a very large
 *  context around before anything happens — and the eventual compaction has
 *  to summarize ~1M tokens in one shot.
 *
 *  Pirouette lets you move that trigger point down to a fraction of the
 *  window ("compact once I'm 40% full"), per model. The only knob pi exposes
 *  is `reserveTokens`, so a fraction `f` is expressed as
 *
 *      reserveTokens = contextWindow - round(contextWindow * f)
 *
 *  which makes `shouldCompact()` fire at `f * contextWindow`. `reserveTokens`
 *  also caps the summary's own `maxTokens` (`0.8 * reserveTokens`, clamped to
 *  the model's `maxTokens`), so making it bigger never starves the summary.
 *
 *  Ordered `rules` allow different fractions for different model globs;
 *  the first match overrides the fallback fraction/model filter.
 *
 *  Configuration (env overrides the corresponding config field):
 *    - `[defaults.compaction]` in pirouette.toml / ~/.pirouette/config.toml
 *    - `PIROUETTE_AUTO_COMPACT_AT` / `PIROUETTE_AUTO_COMPACT_MODELS` /
 *      `PIROUETTE_AUTO_COMPACT_KEEP_RECENT_TOKENS` / `PIROUETTE_AUTO_COMPACT_RULES`
 *
 *  With no configuration the policy is inert and agents keep pi's defaults.
 */

/** Pi's defaults, mirrored here so the module has no import cycle with the
 *  SDK and so tests don't depend on SDK internals. Kept in sync with
 *  `DEFAULT_COMPACTION_SETTINGS` in @earendil-works/pi-coding-agent. */
export const PI_DEFAULT_RESERVE_TOKENS = 16384;
export const PI_DEFAULT_KEEP_RECENT_TOKENS = 20000;

/** Fraction of the trigger point kept verbatim after a compaction when the
 *  user hasn't pinned `keep_recent_tokens`. Compacting a 400k context down
 *  to pi's default 20k throws away far more than necessary; keeping a
 *  quarter of the budget means the agent still remembers the last stretch
 *  of work in full. */
const DEFAULT_KEEP_RECENT_RATIO = 0.25;

/** Guardrails on the configured fraction. Below 5% compaction would fire
 *  again immediately after it finishes; above 95% it isn't buying anything
 *  over pi's own reserve. */
const MIN_FRACTION = 0.05;
const MAX_FRACTION = 0.95;

export interface CompactionRule {
  /** First matching rule wins; patterns match qualified or bare model IDs. */
  models: string[];
  /** 0 restores pi's default reserve for matching models. */
  fraction: number;
}

export interface CompactionPolicy {
  /** Fraction of the context window at which auto-compaction fires. 0 (or
   *  unset) leaves pi's default reserve-based trigger alone. */
  fraction: number;
  /** Model globs the fraction applies to, matched against both
   *  `<provider>/<id>` and the bare `<id>`. Empty = every model. */
  models: string[];
  /** Explicit override for how much recent conversation survives a
   *  compaction. 0 = derive it from the trigger point. */
  keepRecentTokens: number;
  /** Ordered overrides, checked before the fallback fraction/model filter. */
  rules?: CompactionRule[];
}

export const INERT_POLICY: CompactionPolicy = { fraction: 0, models: [], keepRecentTokens: 0, rules: [] };

export interface CompactionRuleConfig {
  models: string[] | string;
  auto_compact_at: number | string;
}

/** `[defaults.compaction]` as written in TOML. All fields optional. */
export interface CompactionConfig {
  auto_compact_at?: number | string;
  auto_compact_models?: string[] | string;
  keep_recent_tokens?: number | string;
  rules?: CompactionRuleConfig[];
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseList(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const items = value.map((v) => String(v).trim()).filter((v) => v !== "");
    return items;
  }
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    return items;
  }
  return null;
}

/** Fractions and percentages share the same validation in defaults and rules. */
function parseFraction(value: unknown, label: string, warnings: string[]): number | null {
  const parsed = parseNumber(value);
  if (parsed === null) {
    warnings.push(`ignoring ${label}=${JSON.stringify(value)}: not a number`);
    return null;
  }
  if (parsed <= 0) return 0;
  const fraction = parsed > 1 ? parsed / 100 : parsed;
  const clamped = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, fraction));
  if (fraction !== clamped) {
    warnings.push(`${label}=${parsed} is outside [${MIN_FRACTION}, ${MAX_FRACTION}]; clamped to ${clamped}`);
  }
  return clamped;
}

function parseRules(value: unknown, warnings: string[]): CompactionRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push("ignoring compaction rules: expected an array");
    return [];
  }
  const rules: CompactionRule[] = [];
  for (const [i, entry] of value.entries()) {
    const label = `rules[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`ignoring ${label}: expected an object`);
      continue;
    }
    const rawModels = entry.models;
    const validModels = typeof rawModels === "string" ||
      (Array.isArray(rawModels) && rawModels.every((model) => typeof model === "string"));
    const models = validModels ? parseList(rawModels) : null;
    if (!models?.length) {
      warnings.push(`ignoring ${label}: models must contain at least one model glob (use "*" to match all)`);
      continue;
    }
    const fraction = parseFraction(entry.auto_compact_at, `${label}.auto_compact_at`, warnings);
    if (fraction !== null) rules.push({ models, fraction });
  }
  return rules;
}

/** Build the effective policy from `[defaults.compaction]` plus env
 *  overrides. Bad values are ignored (with the reason returned in
 *  `warnings`) rather than failing server startup — a typo in a threshold
 *  must not take the fleet down. */
export function resolveCompactionPolicy(
  config: CompactionConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): { policy: CompactionPolicy; warnings: string[] } {
  const warnings: string[] = [];

  const rawFraction = env.PIROUETTE_AUTO_COMPACT_AT ?? config?.auto_compact_at;
  const fraction = rawFraction === undefined || rawFraction === ""
    ? 0
    : parseFraction(rawFraction, "auto_compact_at", warnings) ?? 0;

  let rawRules: unknown = config?.rules;
  const envRules = env.PIROUETTE_AUTO_COMPACT_RULES;
  if (envRules !== undefined && envRules !== "") {
    try {
      const parsed: unknown = JSON.parse(envRules);
      if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
      rawRules = parsed;
    } catch {
      warnings.push("ignoring PIROUETTE_AUTO_COMPACT_RULES: expected a JSON array; using configured rules");
    }
  }
  const rules = parseRules(rawRules, warnings);

  const rawModels = env.PIROUETTE_AUTO_COMPACT_MODELS ?? config?.auto_compact_models;
  const models = parseList(rawModels) ?? [];

  let keepRecentTokens = 0;
  const rawKeep =
    env.PIROUETTE_AUTO_COMPACT_KEEP_RECENT_TOKENS ?? config?.keep_recent_tokens;
  const parsedKeep = parseNumber(rawKeep);
  if (rawKeep !== undefined && rawKeep !== "" && parsedKeep === null) {
    warnings.push(`ignoring keep_recent_tokens=${JSON.stringify(rawKeep)}: not a number`);
  } else if (parsedKeep !== null && parsedKeep > 0) {
    keepRecentTokens = Math.round(parsedKeep);
  }

  return { policy: { fraction, models, keepRecentTokens, rules }, warnings };
}

/** Glob match supporting `*` (any run of characters) only — enough for
 *  `hawk/claude-opus-*` style patterns, and no regex injection surprises
 *  from a config file. Case-insensitive. */
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value.toLowerCase());
}

function matchesModel(patterns: string[], model: { provider?: string; id?: string }): boolean {
  const id = model.id ?? "";
  const qualified = model.provider ? `${model.provider}/${id}` : id;
  return patterns.some((p) => globMatches(p, qualified) || globMatches(p, id));
}

/** Ordered rules override the fallback, including its model filter. A zero
 *  rule deliberately selects pi's defaults instead of falling through. */
function fractionForModel(policy: CompactionPolicy, model: { provider?: string; id?: string }): number {
  const rule = policy.rules?.find((candidate) => matchesModel(candidate.models, model));
  if (rule) return rule.fraction;
  return policy.models.length === 0 || matchesModel(policy.models, model) ? policy.fraction : 0;
}

/** Whether an early-compaction threshold is configured for this model. */
export function policyAppliesTo(
  policy: CompactionPolicy,
  model: { provider?: string; id?: string },
): boolean {
  return fractionForModel(policy, model) > 0;
}

/** The slice of pi's SettingsManager this module touches. Structural so the
 *  tests can exercise it against both the real manager and a stub. */
export interface CompactionSettingsSink {
  applyOverrides(overrides: {
    compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  }): void;
  getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}

/** Push compaction settings into a live SettingsManager.
 *
 *  `applyOverrides()` alone is not enough: it only patches the *merged* view,
 *  and any later `save()` — which pi triggers from unrelated setters like
 *  `setDefaultModelAndProvider()` (on a model switch) and
 *  `setDefaultThinkingLevel()` — rebuilds that view from the global +
 *  project layers, silently dropping the override. Pi exposes a public
 *  setter for `compaction.enabled` but none for the token fields, so we also
 *  write them into the global layer directly, guarded so a future change to
 *  the manager's internals degrades to override-only instead of throwing. */
export function applyCompactionSettings(
  settingsManager: CompactionSettingsSink,
  settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
): void {
  const compaction = {
    enabled: settings.enabled,
    reserveTokens: settings.reserveTokens,
    keepRecentTokens: settings.keepRecentTokens,
  };
  const globalLayer = (
    settingsManager as unknown as {
      globalSettings?: { compaction?: Record<string, unknown> };
    }
  ).globalSettings;
  if (globalLayer && typeof globalLayer === "object") {
    globalLayer.compaction = { ...(globalLayer.compaction ?? {}), ...compaction };
  }
  settingsManager.applyOverrides({ compaction });
}

export interface ResolvedCompactionSettings {
  enabled: true;
  reserveTokens: number;
  keepRecentTokens: number;
  /** Context size (tokens) at which auto-compaction fires, for logging.
   *  Null when the policy doesn't apply and pi's default reserve is used. */
  triggerTokens: number | null;
}

/** Compaction settings for an agent about to run on `model`.
 *
 *  Returns pi's defaults untouched unless the policy applies to this model
 *  and the model reports a usable context window. */
export function compactionSettingsFor(
  policy: CompactionPolicy,
  model: { provider?: string; id?: string; contextWindow?: number } | null | undefined,
): ResolvedCompactionSettings {
  const fallback: ResolvedCompactionSettings = {
    enabled: true,
    reserveTokens: PI_DEFAULT_RESERVE_TOKENS,
    keepRecentTokens: policy.keepRecentTokens || PI_DEFAULT_KEEP_RECENT_TOKENS,
    triggerTokens: null,
  };
  if (!model) return fallback;
  const fraction = fractionForModel(policy, model);
  if (fraction <= 0) return fallback;

  const contextWindow = model.contextWindow ?? 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return fallback;

  const triggerTokens = Math.round(contextWindow * fraction);
  const reserveTokens = contextWindow - triggerTokens;

  // A trigger point that doesn't leave room for pi's own reserve isn't
  // worth acting on — pi would compact at essentially the same place.
  if (reserveTokens <= PI_DEFAULT_RESERVE_TOKENS) return fallback;

  // Keep-recent has to stay comfortably under the trigger, or the "compact"
  // would keep everything it was supposed to drop and fire again on the
  // next turn.
  const desiredKeep =
    policy.keepRecentTokens || Math.round(triggerTokens * DEFAULT_KEEP_RECENT_RATIO);
  const keepRecentTokens = Math.max(
    1000,
    Math.min(desiredKeep, Math.floor(triggerTokens / 2)),
  );

  return { enabled: true, reserveTokens, keepRecentTokens, triggerTokens };
}
