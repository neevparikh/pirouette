/**
 * Fast-mode badge state, tracked per model.
 *
 * Providers that support Anthropic's fast tier (pi-cas-provider,
 * pi-hawk-provider) publish a `pi:fast-mode` event on the shared extension
 * event bus on *every* request they route, so a UI can show whether the
 * turn about to run is billed at premium speed. Two flavors of payload:
 *
 *   1. **Per-request** — carries a `model`. Emitted from the provider's
 *      stream function. `intent` here means "fast tier is being requested
 *      for *this model*", which is `toggle && modelSupportsFastTier`.
 *   2. **Toggle-level** — no `model`. Emitted by the `/fast on|off` command.
 *      `intent` is the provider-wide toggle itself.
 *
 * Keeping a single last-write-wins value for both conflates them, and in a
 * multi-agent server that value is wrong most of the time: pirouette shares
 * one provider instance across every agent, so the badge is repainted by
 * whichever model made a request last. In practice that means an Opus agent's
 * badge is cleared by an unrelated Sonnet request — a concurrent agent on a
 * different model, or, far more often, the `auto-mode` extension's per-tool
 * classifier, which fires a `claude-sonnet-5` request on every mutating tool
 * call in *every* agent. That's the "badge flickers off after each tool call"
 * bug: 656 clobbering events against 606 legitimate Opus 5 ones in a single
 * production log.
 *
 * So we keep both flavors apart:
 *
 *   - `byModel` — the latest per-request report for each model, so the
 *     dashboard can ask "what's the state for *this agent's* model?" and get
 *     an answer that no other agent (or classifier) can trample.
 *   - `global`  — the latest toggle-level report, used as the fallback for a
 *     model that hasn't run a turn yet. Because the toggle is provider-wide,
 *     a toggle-level event also invalidates every per-model entry: after
 *     `/fast off`, the stale `{intent: true, actual: "on"}` we recorded for
 *     Opus must not keep the badge lit until its next turn.
 */
import type { FastModeSnapshot, FastModeState } from "./types.js";

/** Key a model id by its bare name: provider prefix stripped, lowercased.
 *  Providers report their own local id (`claude-opus-5`) while agent configs
 *  and pi's live stats are provider-qualified (`hawk/claude-opus-5`), and the
 *  dashboard has to match one against the other. Returns null for anything
 *  that isn't a usable id, so callers can skip the lookup entirely.
 *
 *  The web client repeats this rule in `pickFastModeState` (src/web/render.js)
 *  — both sides must agree on the key or every lookup misses. */
export function normalizeFastModeModelId(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const bare = model.trim().split("/").pop();
  if (!bare) return null;
  const lowered = bare.toLowerCase();
  return lowered.length > 0 ? lowered : null;
}

/** Normalize an untrusted `pi:fast-mode` payload into a `FastModeState`, or
 *  null if it isn't one. Defensive because this crosses an extension boundary
 *  pirouette doesn't control: unknown `actual` values and non-string models
 *  are dropped rather than passed through to clients. */
export function parseFastModePayload(data: unknown): FastModeState | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { intent?: unknown; actual?: unknown; model?: unknown };
  const actual =
    d.actual === "on" || d.actual === "off" || d.actual === "cooldown" ? d.actual : undefined;
  const model = typeof d.model === "string" && d.model.trim().length > 0 ? d.model : undefined;
  return {
    intent: Boolean(d.intent),
    ...(actual ? { actual } : {}),
    ...(model ? { model } : {}),
  };
}

/** Accumulates `pi:fast-mode` events into a snapshot the dashboard can read
 *  per agent. See the module comment for why the split matters. */
export class FastModeTracker {
  /** Latest toggle-level report (no model). Null until a provider reports. */
  private global: FastModeState | null = null;
  /** Latest per-request report, keyed by `normalizeFastModeModelId`. */
  private readonly byModel = new Map<string, FastModeState>();

  /** Fold an event payload in. Returns the normalized reading plus the new
   *  snapshot, or null if the payload wasn't a fast-mode state at all (caller
   *  should not broadcast). */
  apply(data: unknown): { state: FastModeState; snapshot: FastModeSnapshot } | null {
    const state = parseFastModePayload(data);
    if (!state) return null;
    const key = normalizeFastModeModelId(state.model);
    if (key) {
      this.byModel.set(key, state);
    } else {
      // Provider-wide toggle change: every per-model reading we hold predates
      // it and is now untrustworthy. Drop them and let the next turn per model
      // re-establish ground truth.
      this.global = state;
      this.byModel.clear();
    }
    return { state, snapshot: this.snapshot() };
  }

  /** Current state, safe to serialize onto the wire. */
  snapshot(): FastModeSnapshot {
    return {
      global: this.global,
      byModel: Object.fromEntries(this.byModel),
    };
  }

  /** Whether anything has been recorded yet. Snapshot is otherwise empty and
   *  the badge stays hidden. */
  isEmpty(): boolean {
    return this.global === null && this.byModel.size === 0;
  }

  /** State that applies to `model`, falling back to the provider-wide toggle
   *  when that model hasn't run a turn yet. Mirrors the client's lookup;
   *  exists for tests and for any server-side consumer (e.g. logging). */
  stateFor(model: unknown): FastModeState | null {
    const key = normalizeFastModeModelId(model);
    if (key) {
      const hit = this.byModel.get(key);
      if (hit) return hit;
    }
    return this.global;
  }
}
