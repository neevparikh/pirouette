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
 *  Configuration (later wins):
 *    - `[defaults.compaction]` in pirouette.toml / ~/.pirouette/config.toml
 *    - `PIROUETTE_AUTO_COMPACT_AT` / `PIROUETTE_AUTO_COMPACT_MODELS` /
 *      `PIROUETTE_AUTO_COMPACT_KEEP_RECENT_TOKENS`
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
}

export const INERT_POLICY: CompactionPolicy = { fraction: 0, models: [], keepRecentTokens: 0 };

/** `[defaults.compaction]` as written in TOML. All fields optional. */
export interface CompactionConfig {
  auto_compact_at?: number | string;
  auto_compact_models?: string[] | string;
  keep_recent_tokens?: number | string;
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

/** Build the effective policy from `[defaults.compaction]` plus env
 *  overrides. Bad values are ignored (with the reason returned in
 *  `warnings`) rather than failing server startup — a typo in a threshold
 *  must not take the fleet down. */
export function resolveCompactionPolicy(
  config: CompactionConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): { policy: CompactionPolicy; warnings: string[] } {
  const warnings: string[] = [];

  let fraction = 0;
  const rawFraction = env.PIROUETTE_AUTO_COMPACT_AT ?? config?.auto_compact_at;
  const parsedFraction = parseNumber(rawFraction);
  if (rawFraction !== undefined && rawFraction !== "" && parsedFraction === null) {
    warnings.push(`ignoring auto_compact_at=${JSON.stringify(rawFraction)}: not a number`);
  } else if (parsedFraction !== null && parsedFraction > 0) {
    // Accept both "0.4" and "40" (percent) — the second is the mistake
    // everyone makes at least once.
    const asFraction = parsedFraction > 1 ? parsedFraction / 100 : parsedFraction;
    if (asFraction < MIN_FRACTION || asFraction > MAX_FRACTION) {
      const clamped = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, asFraction));
      warnings.push(
        `auto_compact_at=${parsedFraction} is outside [${MIN_FRACTION}, ${MAX_FRACTION}]; clamped to ${clamped}`,
      );
      fraction = clamped;
    } else {
      fraction = asFraction;
    }
  }

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

  return { policy: { fraction, models, keepRecentTokens }, warnings };
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

/** Whether the policy's fraction applies to this model. An empty model list
 *  means "every model"; otherwise a pattern must match either the qualified
 *  `<provider>/<id>` or the bare `<id>`. */
export function policyAppliesTo(
  policy: CompactionPolicy,
  model: { provider?: string; id?: string },
): boolean {
  if (policy.fraction <= 0) return false;
  if (policy.models.length === 0) return true;
  const id = model.id ?? "";
  const qualified = model.provider ? `${model.provider}/${id}` : id;
  return policy.models.some((p) => globMatches(p, qualified) || globMatches(p, id));
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
  if (!model || !policyAppliesTo(policy, model)) return fallback;

  const contextWindow = model.contextWindow ?? 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return fallback;

  const triggerTokens = Math.round(contextWindow * policy.fraction);
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
