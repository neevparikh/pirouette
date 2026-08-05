/** Picking the model an agent runs on — and refusing to start one whose
 *  provider this host can't actually reach.
 *
 *  Pi resolves provider credentials lazily, at the first LLM call. A model
 *  string naming a provider with no credentials on the host therefore
 *  *creates a session perfectly happily* and only blows up when the agent
 *  is first prompted — by which point the agent exists, looks alive in the
 *  dashboard, and its owner has already walked away. That is a nasty shape
 *  of failure for `pru launch --model <guess>`, which is how one agent
 *  hands work to another: the guess is wrong, the child never runs, and
 *  nothing says so.
 *
 *  So we resolve strictly and pre-flight the credentials up front, at
 *  session start, where the error still has somewhere to go (the launch
 *  request, and the agent's `error` state).
 */

/** The bits of pi's `Model` we need. Kept structural so tests don't have to
 *  build a full pi model record. */
export interface ResolvableModel {
  provider: string;
  id: string;
}

/** Pi's model registry, narrowed to what resolution needs. */
export interface ModelLookup<M extends ResolvableModel> {
  /** Registry lookup. Knows every model in models.json plus the built-ins,
   *  whether or not the host has credentials for the provider. */
  find(provider: string, id: string): M | undefined;
  /** Models whose provider is authenticated right now. Custom providers
   *  (e.g. `hawk`) often declare `models: []` in models.json and only show
   *  up here, so this is also a resolution source, not just a filter. */
  getAvailable(): Promise<readonly M[]> | readonly M[];
  /** Ask the same question pi asks before it starts a turn: can this
   *  model's provider authenticate right now? `{ ok: false }` means the
   *  agent's first prompt is going to throw instead of running. */
  checkAuth(model: M): Promise<{ ok: boolean; error?: string }>;
}

/** Split `provider/id`. A bare id is assumed to be Anthropic's, matching
 *  pi's own default. */
export function splitQualifiedModel(requested: string): [provider: string, id: string] {
  const slash = requested.indexOf("/");
  if (slash < 0) return ["anthropic", requested];
  return [requested.slice(0, slash), requested.slice(slash + 1)];
}

/** `hawk/claude-opus-5, hawk/gpt-5, … (77 more)` — enough to correct a
 *  wrong guess without dumping 79 lines into an error message. */
export function formatReachableModels(
  models: readonly ResolvableModel[],
  limit = 8,
): string {
  if (models.length === 0) {
    return "none — no provider on this host is authenticated (check ~/.pi/agent/auth.json)";
  }
  const shown = models.slice(0, limit).map((m) => `${m.provider}/${m.id}`);
  const rest = models.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, … (${rest} more)` : shown.join(", ");
}

/** Advice appended to every resolution failure. The common caller is an
 *  agent running `pru launch --model <something it half-remembered>`. */
const DEFAULT_MODEL_HINT =
  "Omit --model to use this host's default (PIROUETTE_DEFAULT_MODEL), or copy " +
  "the model you are running on yourself ($PI_PROVIDER/$PI_MODEL).";

/** Resolve `requested` to a model that will actually answer a prompt.
 *
 *  Throws when the model is unknown, and — the case that used to slip
 *  through — when it is known but its provider has no credentials here. */
export async function resolveAgentModel<M extends ResolvableModel>(
  requested: string,
  lookup: ModelLookup<M>,
): Promise<M> {
  const [provider, modelId] = splitQualifiedModel(requested);

  const available = await lookup.getAvailable();
  const model =
    lookup.find(provider, modelId) ??
    available.find((m) => m.provider === provider && m.id === modelId);

  if (!model) {
    throw new Error(
      `Model "${requested}" not found. Reachable models: ${formatReachableModels(available)}. ` +
        DEFAULT_MODEL_HINT,
    );
  }

  // Pre-flight the credentials. Same check pi runs at the top of a turn,
  // just hours earlier — while someone is still listening.
  const auth = await lookup.checkAuth(model);
  if (!auth.ok) {
    throw new Error(
      `Model "${model.provider}/${model.id}" is registered but not usable on this host: ` +
        `${auth.error ?? `no credentials for provider "${model.provider}"`}. ` +
        `Reachable models: ${formatReachableModels(available)}. ` +
        DEFAULT_MODEL_HINT,
    );
  }

  return model;
}
