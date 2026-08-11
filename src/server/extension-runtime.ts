/** Keeping pi's process-shared extension runtime usable across agents.
 *
 *  Pirouette runs every agent in ONE process behind ONE
 *  `DefaultResourceLoader`, so all sessions share a single pi *extension
 *  runtime* object (`loader.getExtensions().runtime`). That object backs the
 *  `pi` handle every extension captured at load time: `pi.getFlag()`,
 *  `pi.setModel()`, `pi.sendMessage()` and friends all call
 *  `runtime.assertActive()` first.
 *
 *  Pi, however, assumes one session per runtime. `AgentSession.dispose()`
 *  calls `runner.invalidate()`, which marks *the shared runtime* stale
 *  forever (`state.staleMessage ??= …`) so that an extension can't keep
 *  using a ctx captured before `newSession()` / `fork()` / `reload()`.
 *
 *  In a multi-agent server that guard misfires catastrophically. Stopping a
 *  single agent — `pru stop`, `/new`, archive, handoff, remove — poisons the
 *  runtime for the whole box. Every extension that touches a `pi.*` action
 *  from then on throws:
 *
 *    This extension ctx is stale after session replacement or reload. …
 *
 *  Observed failure: after one `/new`, every *newly launched* agent died on
 *  its first tool call, because the auto-mode extension's `tool_call` hook
 *  calls `pi.getFlag("auto-mode")` for an agent it hasn't seen before. Agents
 *  that were already running kept working (their answer was memoised), which
 *  made it look like one bad agent rather than a server-wide outage. Only a
 *  restart cleared it.
 *
 *  The fix is to stop *session* disposal from invalidating the *shared*
 *  runtime. Per-session staleness is untouched: `ExtensionRunner.invalidate()`
 *  still sets its own `staleMessage` before delegating here, so a ctx captured
 *  from a disposed session still throws via `runner.assertActive()`. What we
 *  drop is only the process-wide flag, which in pirouette can never be right —
 *  the runtime outlives every individual session by design.
 */

/** The slice of pi's extension runtime we touch. Pi doesn't export the type,
 *  and the object carries a lot more (action methods, flag values, pending
 *  provider registrations) that we deliberately leave alone. */
export interface SharedExtensionRuntime {
  invalidate: (message?: string) => void;
  assertActive: () => void;
}

/** Shape of `ResourceLoader.getExtensions()` for our purposes. */
export interface ExtensionsResult {
  runtime?: SharedExtensionRuntime;
}

/** Runtimes we've already neutered. A `reload()` swaps in a brand-new runtime
 *  object, so this is keyed per object rather than being a one-shot flag. */
const guarded = new WeakSet<SharedExtensionRuntime>();

/** Neutralise `runtime.invalidate()` so disposing one agent's session can't
 *  mark the shared runtime stale for every other agent.
 *
 *  Idempotent, and safe to call on a runtime that is already stale — in that
 *  case we can't un-stick it (pi keeps `staleMessage` in a closure with no
 *  setter), so we log and leave it; the caller has bigger problems and a
 *  restart is the only cure. Returns true if the runtime is now protected. */
export function keepSharedExtensionRuntimeActive(
  runtime: SharedExtensionRuntime | undefined,
  log: (message: string) => void = () => {},
): boolean {
  if (!runtime) return false;
  if (guarded.has(runtime)) return true;

  try {
    runtime.assertActive();
  } catch (err) {
    log(
      `[extension-runtime] shared runtime was already stale before we could guard it; ` +
        `agents will fail their tool calls until the server restarts: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  runtime.invalidate = () => {
    // Deliberately a no-op. See the module comment: in a one-session-per-
    // process pi this marks a real bug; here it's just an agent stopping.
  };
  guarded.add(runtime);
  return true;
}

/** Convenience wrapper for the `getExtensions()` result, which is what
 *  callers actually hold. Returns the same object so it can be used inline:
 *  `getExtensions: () => guardExtensionsResult(loader.getExtensions())`. */
export function guardExtensionsResult<T extends ExtensionsResult>(
  extensions: T,
  log: (message: string) => void = () => {},
): T {
  keepSharedExtensionRuntimeActive(extensions.runtime, log);
  return extensions;
}
