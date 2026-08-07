/** Manages pi SDK agent sessions — create, resume, stop, send messages. */

import { mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  loadProjectContextFiles,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type EventBusController,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";


import { getConfig } from "../config.js";
import {
  bashTimeoutGuidance,
  createBashTimeoutExtension,
  isInertBashTimeoutPolicy,
  resolveBashTimeoutPolicy,
  type BashTimeoutPolicy,
} from "./bash-timeout.js";
import {
  applyCompactionSettings,
  compactionSettingsFor,
  resolveCompactionPolicy,
  type CompactionPolicy,
} from "./compaction-policy.js";
import { createWorktree, removeWorktree } from "./git.js";
import { resolveAgentModel } from "./model-resolution.js";
import { setupWorktreeDataTools } from "./worktree-setup.js";
import { ProjectManager } from "./project-manager.js";
import { StateManager } from "./state.js";
import { normalizeEvent } from "./normalize.js";
import { consumeRestartNotice, type RestartNotice } from "./restart-notice.js";
import { FastModeTracker } from "./fast-mode.js";
import {
  createPirouetteUIContext,
  type PendingUIRequest,
  type UIContextHost,
} from "./pirouette-ui-context.js";
import {
  DEFAULT_PROJECT_NAME,
  emptyUsage,
  type AgentConfig,
  type AgentState,
  type AgentWidget,
  type ChatImage,
  type ChatMessage,
  type DeleteAgentOptions,
  type ExtensionUIRequest,
  type FastModeSnapshot,
  type InterruptResult,
  type InterruptTarget,
  type NormalizedEvent,
  type WsEnvelope,
} from "./types.js";

/** Default nudge injected as a user turn when auto-continuing an agent whose
 *  turn was interrupted by a server restart. Overridable via
 *  PIROUETTE_RESUME_CONTINUE_MESSAGE. Kept explicit about *why* it appeared
 *  so the agent (and a human reading the transcript) understands the jump. */
const DEFAULT_RESUME_CONTINUE_MESSAGE =
  "[pirouette] The server restarted and interrupted your previous turn " +
  "(a command or response was aborted mid-execution). Review the state of " +
  "your work and continue from where you left off.";

/** Nudge for the agent that ran `pru self-update`. Its turn had usually
 *  already ended by the time the installer restarted the server, so the
 *  "your turn was interrupted" wording would be wrong — but it still needs
 *  waking up, otherwise the agent that asked for the update is the one
 *  agent that never comes back. Overridable via
 *  PIROUETTE_SELF_UPDATE_RESUME_MESSAGE. */
const DEFAULT_SELF_UPDATE_RESUME_MESSAGE =
  "[pirouette] The self-update you started has finished and the server " +
  "restarted, which aborted any commands that were still running. You are " +
  "now on the new build. Re-check anything that was in flight and continue " +
  "from where you left off.";

/** Grace period between handing an agent's work over to its successor and
 *  tearing the old session down. The handoff is normally requested *by* the
 *  outgoing agent from inside a tool call, so an immediate stop would kill
 *  the call before its result (the successor's id) ever reaches it. */
const HANDOFF_PARENT_STOP_DELAY_MS = 5_000;

/** Name for the agent taking over from `name`: `foo` → `foo-2` → `foo-3`.
 *  Successive handoffs on a long-running task read as one numbered series
 *  in the sidebar instead of `foo-handoff-handoff-handoff`. */
export function nextHandoffName(name: string): string {
  const trimmed = name.trim() || "agent";
  const match = trimmed.match(/^(.*?)-(\d+)$/);
  if (match) {
    const [, stem, n] = match;
    return `${stem}-${Number(n) + 1}`;
  }
  return `${trimmed}-2`;
}

/** Skills bundled with the pirouette package. Resolves to `<pkg>/skills`
 *  from both `src/server/` (dev, via tsx) and `dist/server/` (installed),
 *  since the built layout mirrors the source layout one level down. */
export function packagedSkillsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
}

/** How long `interruptAgent()` waits for pi's `session.abort()` to reach
 *  idle before giving up on the wait (the abort signal has already been
 *  fired at that point; a wedged tool teardown shouldn't hold the HTTP
 *  response open). */
const INTERRUPT_ABORT_TIMEOUT_MS = 10_000;

/** Backoff before each background attempt to resume an agent whose initial
 *  resume failed (transient auth/network hiccups right after a restart). */
const RESUME_RETRY_DELAYS_MS = [15_000, 60_000, 180_000];

/** Delay *before* each post-restart nudge attempt. The first is immediate;
 *  later ones give a still-waking provider stack time to settle. */
const NUDGE_ATTEMPT_DELAYS_MS = [0, 10_000, 45_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/** The message handed to the agent that triggered a self-update, with the
 *  install plan appended when we know it. */
function selfUpdateResumeMessage(notice?: RestartNotice): string {
  const base =
    process.env.PIROUETTE_SELF_UPDATE_RESUME_MESSAGE?.trim() ||
    DEFAULT_SELF_UPDATE_RESUME_MESSAGE;
  return notice?.plan ? `${base} (installed: ${notice.plan})` : base;
}

/** Race a promise against a timeout. Resolves with the promise's value if
 *  it settles in time; rejects with a timeout error otherwise. Used to
 *  bound per-agent teardown during shutdown so one stuck operation can't
 *  hold the whole process past systemd's TimeoutStopSec. The underlying
 *  promise is left to settle on its own (we're tearing down anyway). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Pull image content blocks out of a pi message's content array, formatted
 *  for the dashboard. Pi stores images as `{ type: "image", data, mimeType }`
 *  (base64 data); the dashboard wants a ready-to-use `data:<mime>;base64,...`
 *  data URI it can put straight into <img src=...>. */
function pickImageContent(
  content: unknown,
): ChatImage[] {
  if (!Array.isArray(content)) return [];
  const out: ChatImage[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: string }).type === "image" &&
      "data" in block &&
      "mimeType" in block
    ) {
      const b = block as { data: string; mimeType: string };
      out.push({ dataUrl: `data:${b.mimeType};base64,${b.data}`, mimeType: b.mimeType });
    }
  }
  return out;
}

export interface AgentHandle {
  config: AgentConfig;
  session: AgentSession;
  unsubscribe: () => void;
  /** The session's settings manager. Held so model switches can recompute
   *  the auto-compaction threshold, which is derived from the model's
   *  context window (see compaction-policy.ts). */
  settingsManager: SettingsManager;
}

export type AgentEventCallback = (agentId: string, event: NormalizedEvent) => void;
export type AgentStateCallback = (agentId: string, state: AgentState) => void;
/** Sink for envelopes the AgentManager wants broadcast to all WS clients.
 *  Wired by the server (`runServer()` passes its `broadcast(envelope)`).
 *  Keeps AgentManager free of any direct WebSocket import. */
export type WsBroadcastCallback = (envelope: WsEnvelope) => void;

export class AgentManager {
  private handles = new Map<string, AgentHandle>();
  private eventListeners: AgentEventCallback[] = [];
  private stateListeners: AgentStateCallback[] = [];
  private wsBroadcastCallbacks: WsBroadcastCallback[] = [];

  /** Per-agent operation queue. Every create/resume/stop/send/remove for a
   *  given agent runs through `withAgentLock(id, ...)` to prevent races
   *  (e.g. sendMessage arriving mid-resume, double-stop, etc). */
  private agentLocks = new Map<string, Promise<unknown>>();

  /** Pending ExtensionUIContext requests waiting on a browser response.
   *  Keyed by requestId (unique across all agents). Entries are added by
   *  createPirouetteUIContext's host hook and removed when the user
   *  answers, the request is cancelled (by AbortSignal / agent stop /
   *  server shutdown), or another client wins the race. */
  private pendingUIRequests = new Map<string, PendingUIRequest>();

  /** Latest widget per agent per `setWidget` key (see widget-render.ts).
   *  Held here rather than only broadcast so a browser that connects or
   *  refreshes mid-session is primed with widgets set before it joined.
   *  Cleared when the agent's session goes away — a widget describes
   *  live session state, so a stale one would outlive its meaning. */
  private widgets = new Map<string, Map<string, AgentWidget>>();

  /** Canonical model/auth runtime. Created once during resource-loader init
   *  (async, so it can't live in the constructor). Shared with every session
   *  we create via createAgentSession, so extension-registered providers are
   *  visible to both our lookups and the session's internal registry. */
  private modelRuntime!: ModelRuntime;
  /** Synchronous facade over `modelRuntime` for provider registration and
   *  model lookup. Populated alongside `modelRuntime`. */
  private modelRegistry!: ModelRegistry;
  /** Shared ResourceLoader. We load it once at init so extensions (like
   *  pi-hawk-provider) register their providers + models in the modelRegistry
   *  before any agent session is created. Every session reuses this loader.
   */
  private resourceLoader: DefaultResourceLoader | null = null;
  private resourceLoaderInit: Promise<void> | null = null;
  /** Shared extension event bus, handed to the ResourceLoader so every
   *  extension's `pi.events` is the same instance. We hold a reference to
   *  subscribe to provider-wide channels like pi-cas-provider's
   *  `pi:fast-mode` and relay them to the dashboard. */
  private eventBus: EventBusController | null = null;
  /** Fast-mode badge state, tracked per model (one shared provider serves
   *  every agent, so a single value would be repainted by whichever model
   *  requested last). Mirrored to clients via the `fast_mode` WS envelope and
   *  primed on connect via getFastModeSnapshot(). */
  private readonly fastMode = new FastModeTracker();

  /** Auto-compaction policy (`[defaults.compaction]` + PIROUETTE_AUTO_COMPACT_*).
   *  Resolved once on first use; warnings are logged once, not per agent. */
  private compactionPolicy: CompactionPolicy | null = null;

  /** Deadline for agent `bash` calls (`[defaults.bash_timeout]` +
   *  PIROUETTE_BASH_*_TIMEOUT_SECONDS). Resolved once, before the resource
   *  loader is built — the inline extension that enforces it is registered
   *  there. */
  private bashTimeoutPolicy: BashTimeoutPolicy | null = null;

  constructor(
    private readonly stateManager: StateManager,
    private readonly projectManager: ProjectManager,
    private readonly dataDir: string,
  ) {}

  /** Serialize operations on a single agent. If a prior op is in flight, the
   *  new one waits for it. Prevents races like "send while starting" or
   *  "stop while resume is mid-flight". */
  private async withAgentLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.agentLocks.get(id) ?? Promise.resolve();
    // Chain behind the previous op regardless of outcome. The returned
    // promise reflects fn's real result (caller sees errors); the stored
    // tail swallows errors so a failure doesn't poison subsequent waiters.
    const work = prev.then(fn, fn);
    const tail: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    this.agentLocks.set(id, tail);
    try {
      return await work;
    } finally {
      // Drop the map entry if nobody else chained behind us, to keep it small.
      if (this.agentLocks.get(id) === tail) {
        this.agentLocks.delete(id);
      }
    }
  }

  /** Lazily init and reload the shared ResourceLoader. Idempotent.
   *
   *  Also flushes pending provider registrations from extensions into our
   *  modelRegistry, so custom providers like `hawk` (pi-hawk-provider) are
   *  available for model lookup before we call createAgentSession. This
   *  mirrors what the pi CLI does in main.js after resourceLoader.reload().
   */
  private async ensureResourceLoader(): Promise<DefaultResourceLoader> {
    if (this.resourceLoader) return this.resourceLoader;
    if (!this.resourceLoaderInit) {
      this.resourceLoaderInit = (async () => {
        // Own the extension event bus so we can subscribe to provider-wide
        // channels (e.g. pi-cas-provider's `pi:fast-mode`). Passing it in
        // explicitly means every extension's `pi.events` is this same
        // instance; otherwise the loader would create a private one we
        // couldn't reach.
        const eventBus = createEventBus();
        this.eventBus = eventBus;
        eventBus.on("pi:fast-mode", (data) => this.handleFastModeEvent(data));

        // Canonical model/auth runtime, using the default agent dir paths
        // (auth.json / models.json) — matches what createAgentSession would
        // build for itself. We share this exact instance with every session
        // so extension provider registrations flow through to them.
        this.modelRuntime = await ModelRuntime.create();
        this.modelRegistry = new ModelRegistry(this.modelRuntime);

        const loader = new DefaultResourceLoader({
          cwd: this.dataDir,
          agentDir: getAgentDir(),
          eventBus,
          // Give every agent bash call a deadline. Pi's bash tool waits
          // forever when the model omits `timeout`, which it nearly always
          // does — one `find /` and the agent is wedged in a tool call with
          // nothing to show for it until a human interrupts.
          extensionFactories: isInertBashTimeoutPolicy(this.getBashTimeoutPolicy())
            ? []
            : [
                createBashTimeoutExtension(this.getBashTimeoutPolicy(), (msg) =>
                  console.log(`[agent-manager] ${msg}`),
                ),
              ],
          // Skills that ship with pirouette itself (skills/<name>/SKILL.md
          // in the package). They document pirouette-specific workflows
          // — handing off to a fresh agent, for one — that an agent can't
          // be expected to figure out from the API surface alone. User
          // skills in ~/.pi/agent/skills still win on a name collision.
          additionalSkillPaths: [packagedSkillsDir()],
        });
        await loader.reload();
        this.resourceLoader = loader;
        const exts = loader.getExtensions();
        console.log(
          `[agent-manager] resource loader ready: ${exts.extensions.length} extension(s)` +
            (exts.extensions.length > 0
              ? `: ${exts.extensions.map((e: { path?: string }) => e.path ?? "(inline)").join(", ")}`
              : ""),
        );
        for (const err of exts.errors) {
          console.log(`[agent-manager] extension error: ${err.path}: ${err.error}`);
        }

        // Skills: same loader handles them. Log so we can debug "my skills
        // aren't loading" without ssh-ing into the box.
        const skillsResult = loader.getSkills();
        console.log(
          `[agent-manager] resource loader: ${skillsResult.skills.length} skill(s)` +
            (skillsResult.skills.length > 0
              ? `: ${skillsResult.skills.map((s: { name: string }) => s.name).join(", ")}`
              : ""),
        );
        for (const d of skillsResult.diagnostics) {
          console.log(
            `[agent-manager] skill diagnostic: ${(d as { severity?: string }).severity ?? "?"} ${(d as { message?: string }).message ?? JSON.stringify(d)}`,
          );
        }

        // Flush pending provider registrations into our modelRegistry so custom
        // providers are available for lookup before createAgentSession runs.
        const pending = (exts as {
          runtime?: { pendingProviderRegistrations?: Array<{ name: string; config: unknown; extensionPath?: string }> };
        }).runtime?.pendingProviderRegistrations ?? [];
        let registered = 0;
        for (const { name, config, extensionPath } of pending) {
          try {
            this.modelRegistry.registerProvider(
              name,
              config as Parameters<ModelRegistry["registerProvider"]>[1],
            );
            registered++;
          } catch (err) {
            console.log(
              `[agent-manager] provider registration failed from ${extensionPath ?? "?"}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        if (registered > 0) {
          console.log(`[agent-manager] registered ${registered} provider(s) from extensions`);
        }

        // Summary: providers available for lookup. Use the runtime's async
        // getAvailable() so freshly-registered providers are refreshed into
        // the availability snapshot that the synchronous facade reads later.
        try {
          const avail = await this.modelRuntime.getAvailable();
          const byProvider = new Map<string, number>();
          for (const m of avail) byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
          const summary = [...byProvider.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([p, n]) => `${p}=${n}`)
            .join(", ");
          console.log(`[agent-manager] ${avail.length} models available (${summary}${byProvider.size > 6 ? ", …" : ""})`);
        } catch {
          // non-fatal
        }
        // Clear so the pi runtime doesn't try to re-register later.
        if ((exts as { runtime?: { pendingProviderRegistrations?: unknown[] } }).runtime) {
          (exts as { runtime: { pendingProviderRegistrations: unknown[] } }).runtime.pendingProviderRegistrations = [];
        }
      })();
    }
    await this.resourceLoaderInit;
    if (!this.resourceLoader) throw new Error("ResourceLoader failed to init");
    return this.resourceLoader;
  }

  onEvent(cb: AgentEventCallback): void {
    this.eventListeners.push(cb);
  }

  onStateChange(cb: AgentStateCallback): void {
    this.stateListeners.push(cb);
  }

  /** Register a sink for WS envelopes the AgentManager wants broadcast to
   *  all clients (today: extension UI request/cancel/notify/status from
   *  bound extensions). The server wires its `broadcast(envelope)` here so
   *  pirouette-ui-context.ts can dispatch without importing `ws`. */
  onWsBroadcast(cb: WsBroadcastCallback): void {
    this.wsBroadcastCallbacks.push(cb);
  }

  private emitEvent(agentId: string, event: NormalizedEvent): void {
    for (const cb of this.eventListeners) cb(agentId, event);
  }

  private emitStateChange(agentId: string, state: AgentState): void {
    for (const cb of this.stateListeners) cb(agentId, state);
  }

  private broadcastWs(envelope: WsEnvelope): void {
    for (const cb of this.wsBroadcastCallbacks) cb(envelope);
  }

  // --- ExtensionUIContext bridge ------------------------------------------
  //
  // See pirouette-ui-context.ts for the flow. AgentManager owns the
  // pendingUIRequests map and provides:
  //   - a UIContextHost interface to the per-agent UI context (closes
  //     over `agentId`, calls `registerRequest` / `broadcast`)
  //   - inbound resolve/cancel methods called by the server's WS message
  //     handler when a browser posts back
  //   - snapshot for replay-on-reconnect so new WS clients see any
  //     in-flight request immediately
  //   - bulk-cancel hooks called from agent stop / server shutdown so a
  //     dying agent doesn't leave a Promise hanging forever inside the
  //     SDK's canUseTool callback.

  private uiContextHostFor(agentId: string): UIContextHost {
    return {
      registerRequest: (entry) => {
        this.pendingUIRequests.set(entry.request.requestId, entry);
        this.broadcastWs({
          kind: "extension_ui_request",
          agentId: entry.agentId,
          request: entry.request,
        });
      },
      broadcast: (envelope) => this.broadcastWs(envelope),
      newRequestId: () => randomUUID(),
      setWidget: (key, widget) => {
        let forAgent = this.widgets.get(agentId);
        if (widget === null) {
          forAgent?.delete(key);
          if (forAgent?.size === 0) this.widgets.delete(agentId);
        } else {
          if (!forAgent) {
            forAgent = new Map<string, AgentWidget>();
            this.widgets.set(agentId, forAgent);
          }
          forAgent.set(key, widget);
        }
        this.broadcastWs({ kind: "extension_ui_widget", agentId, widgetKey: key, widget });
      },
    };
  }

  /** Every widget currently set, across all agents — the initial prime
   *  for a new WS connection. */
  snapshotAllWidgets(): Array<{ agentId: string; widget: AgentWidget }> {
    const out: Array<{ agentId: string; widget: AgentWidget }> = [];
    for (const [agentId, forAgent] of this.widgets) {
      for (const widget of forAgent.values()) out.push({ agentId, widget });
    }
    return out;
  }

  /** Drop every widget for an agent and tell clients to clear them.
   *  Called when the session is torn down (stop / new session / remove);
   *  extensions re-publish their widgets on the next `session_start`. */
  private clearWidgetsForAgent(agentId: string): void {
    const forAgent = this.widgets.get(agentId);
    if (!forAgent) return;
    const keys = [...forAgent.keys()];
    this.widgets.delete(agentId);
    for (const key of keys) {
      this.broadcastWs({ kind: "extension_ui_widget", agentId, widgetKey: key, widget: null });
    }
  }

  /** Browser posted back an answer. Resolves the awaiting Promise and
   *  broadcasts a cancel so any other open client tab closes its modal.
   *  Idempotent — no-op if the entry's already been settled (race with
   *  AbortSignal or another tab winning). */
  resolveUIResponse(
    agentId: string,
    requestId: string,
    value: string | string[] | boolean,
  ): void {
    const entry = this.pendingUIRequests.get(requestId);
    if (!entry) return;
    if (entry.agentId !== agentId) {
      // Defensive: requestIds are server-minted so this shouldn't happen
      // unless a client posts back a forged envelope. Drop it.
      console.warn(
        `[agent-manager] extension_ui_response agentId mismatch: ` +
          `pending=${entry.agentId} got=${agentId}`,
      );
      return;
    }
    this.pendingUIRequests.delete(requestId);
    this.broadcastWs({ kind: "extension_ui_cancel", agentId, requestId });
    entry.resolve(value);
  }

  /** Browser explicitly cancelled (escape / close button). Same shape as
   *  the AbortSignal path: degrade to undefined/false per dialog flavor
   *  (the UI context wrapper does the translation). */
  cancelUIRequest(agentId: string, requestId: string, reason = "client cancelled"): void {
    const entry = this.pendingUIRequests.get(requestId);
    if (!entry) return;
    if (entry.agentId !== agentId) {
      console.warn(
        `[agent-manager] extension_ui_cancel agentId mismatch: ` +
          `pending=${entry.agentId} got=${agentId}`,
      );
      return;
    }
    this.pendingUIRequests.delete(requestId);
    this.broadcastWs({ kind: "extension_ui_cancel", agentId, requestId });
    entry.resolve(undefined);
    void reason; // captured for future logging
  }

  /** Snapshot the still-open requests for an agent. Used by the server on
   *  new WS connections to replay in-flight prompts to a (re)joining
   *  client so a refresh / zero-clients-at-fire doesn't strand the
   *  agent. */
  snapshotPendingForAgent(agentId: string): ExtensionUIRequest[] {
    const out: ExtensionUIRequest[] = [];
    for (const entry of this.pendingUIRequests.values()) {
      if (entry.agentId === agentId) out.push(entry.request);
    }
    return out;
  }

  /** All in-flight requests across all agents — used for the initial
   *  snapshot on a brand-new WS connection. */
  snapshotAllPending(): Array<{ agentId: string; request: ExtensionUIRequest }> {
    return [...this.pendingUIRequests.values()].map((entry) => ({
      agentId: entry.agentId,
      request: entry.request,
    }));
  }

  /** Reject every pending request for an agent. Called from stopAgent /
   *  removeAgent so the SDK's canUseTool Promise unblocks (with the
   *  cancel sentinel) instead of hanging forever. */
  private cancelAllUIRequestsForAgent(agentId: string, reason: string): void {
    const matching = [...this.pendingUIRequests.entries()].filter(
      ([, e]) => e.agentId === agentId,
    );
    for (const [requestId, entry] of matching) {
      this.pendingUIRequests.delete(requestId);
      this.broadcastWs({ kind: "extension_ui_cancel", agentId, requestId });
      entry.resolve(undefined);
    }
    if (matching.length > 0) {
      console.log(
        `[agent-manager] cancelled ${matching.length} pending UI request(s) for ${agentId} (${reason})`,
      );
    }
  }

  private sessionsDir(): string {
    return path.join(this.dataDir, "sessions");
  }

  /** Build a filesystem-safe slug for an agent name. Used as a directory
   *  name component and as the agent/<slug> git branch suffix. */
  private agentSlug(name: string, id: string): string {
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "agent";
    return `${slug}-${id}`;
  }

  /** Session directory for an agent's pi JSONL session files. Session files
   *  are keyed on the slug so name collisions at the project level don't
   *  clobber each other. */
  private agentSessionDir(name: string, id: string): string {
    return path.join(this.sessionsDir(), this.agentSlug(name, id));
  }

  // --- public API ---

  getRunningAgents(): AgentConfig[] {
    return [...this.handles.values()].map((h) => h.config);
  }

  getAllAgents(): AgentConfig[] {
    return this.stateManager.getAgents();
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.stateManager.getAgent(id);
  }

  /** Rename a chat. Display-only: the agent keeps its id, worktree,
   *  branch and session directory, all of which were slugged from the
   *  ORIGINAL name at creation time and are load-bearing (git worktrees
   *  are registered by path, session files by directory). So
   *  `agent/flaky-test-hunt-ab12cd34` stays put while the sidebar starts
   *  saying `pr-42`.
   *
   *  Names are not unique — two projects can both have a `review` chat.
   *  `resolveAgentRef` already reports that as ambiguous and asks for an
   *  id, so we don't reject collisions here. Returns the updated config,
   *  or null if the agent is unknown. */
  renameAgent(id: string, name: string): AgentConfig | null {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("agent name is required");
    const config = this.stateManager.getAgent(id);
    if (!config) return null;
    const previous = config.name;
    this.stateManager.updateAgentState(id, { name: trimmed });
    const handle = this.handles.get(id);
    if (handle) handle.config.name = trimmed;
    console.log(`[agent-manager] renamed ${previous} (${id}) -> ${trimmed}`);
    return this.stateManager.getAgent(id) ?? null;
  }

  /** Mark an agent archived / unarchived. Archived agents remain fully
   *  functional and on disk; the dashboard hides them from the default
   *  listing. Purely a metadata flag. */
  setArchived(id: string, archived: boolean): void {
    this.stateManager.updateAgentState(id, { archived: !!archived });
    const handle = this.handles.get(id);
    if (handle) handle.config.archived = !!archived;
  }

  /** Pull a chat back out of the archive because the user just did
   *  something that proves they're still using it (today: sent a message).
   *
   *  Archiving is a "tuck this away, I'm done with it" gesture, so a new
   *  message contradicts it. Leaving the chat archived would hide the
   *  agent's reply behind the "show archived" toggle -- the user types,
   *  the chat stays invisible in the sidebar, and the response looks lost.
   *
   *  Broadcasts `agent_updated` (same envelope the /archive endpoint
   *  sends) so every open dashboard moves the chat back into the default
   *  listing without a refresh. No-op when the chat isn't archived, so
   *  this is cheap to call on every message. */
  private unarchiveOnActivity(id: string): void {
    const config = this.stateManager.getAgent(id);
    if (!config?.archived) return;
    console.log(`[agent-manager] unarchiving ${config.name} (${id}): user sent a message`);
    this.setArchived(id, false);
    const updated = this.stateManager.getAgent(id);
    if (updated) {
      this.broadcastWs({
        kind: "agent_updated",
        agentId: id,
        agent: { ...updated, running: this.handles.has(id) },
      });
    }
  }

  /** Resolve a CLI/URL agent reference (id or human-friendly name) to a
   *  single agent. Strategy:
   *    1. Exact id match wins (canonical case).
   *    2. Exact name match — only if there's a unique result. Multiple
   *       agents can share a name (different projects), in which case
   *       this returns null and the caller should report ambiguity.
   *  Returns:
   *    - the agent if uniquely resolvable
   *    - { ambiguous: true, matches } if a name matches >1 agent
   *    - null if nothing matches */
  resolveAgentRef(
    ref: string,
  ): AgentConfig | { ambiguous: true; matches: AgentConfig[] } | null {
    const byId = this.stateManager.getAgent(ref);
    if (byId) return byId;
    const byName = this.stateManager.getAgents().filter((a) => a.name === ref);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) return { ambiguous: true, matches: byName };
    return null;
  }

  isRunning(id: string): boolean {
    return this.handles.has(id);
  }

  /** Skills the shared ResourceLoader has discovered, in load order.
   *  Returns an empty list if the loader hasn't initialised yet (callers
   *  can still ensureResourceLoader() first if they need a synchronous
   *  truth). The dashboard uses this to populate the slash-command
   *  autocomplete for `/skill:<name>`. */
  getSkills(): Array<{ name: string; description: string }> {
    if (!this.resourceLoader) return [];
    const { skills } = this.resourceLoader.getSkills();
    return skills.map((s) => ({
      name: s.name,
      description: (s as { description?: string }).description ?? "",
    }));
  }

  /** Slash commands registered by pi extensions (via `pi.registerCommand`).
   *
   *  Pulled from any currently-running agent's internal `_extensionRunner`.
   *  Pi's extension model registers commands per-runner, but every running
   *  agent's runner loads from the same shared ResourceLoader, so they all
   *  hold identical command sets — any one is canonical.
   *
   *  Returns an empty list when no agent is running (or no extension has
   *  registered a command yet). In that case the dashboard simply won't
   *  autocomplete extension commands; users can still type them and pi's
   *  command handler dispatches them server-side via `session.prompt()`.
   *  We reach into the private `_extensionRunner` field deliberately — pi
   *  doesn't expose this on its public AgentSession surface, but pirouette
   *  already reaches into private fields elsewhere (e.g. `setModel`,
   *  `getSessionStats`) for the same dashboard wiring. */
  getExtensionCommands(): Array<{ name: string; description: string }> {
    for (const handle of this.handles.values()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runner = (handle.session as any)._extensionRunner;
      if (!runner || typeof runner.getRegisteredCommands !== "function") continue;
      try {
        const commands = runner.getRegisteredCommands() as Array<{
          invocationName: string;
          description?: string;
        }>;
        return commands.map((c) => ({
          name: c.invocationName,
          description: c.description ?? "",
        }));
      } catch {
        // try the next handle; one runner's bad shouldn't poison the
        // whole list (also belt-and-suspenders against pi internals
        // changing under us).
      }
    }
    return [];
  }

  /** Whether `text` is a slash command registered by a pi extension (via
   *  `pi.registerCommand`) on this handle's session -- e.g. `/fast` from
   *  pi-cas-provider. Such commands cannot be queued via steer()/followUp()
   *  (pi throws); they must be dispatched through prompt(). Reaches into
   *  pi's private `_extensionRunner` -- same deliberate pattern as
   *  getExtensionCommands(). Returns false for non-slash text, unknown
   *  commands, or when the runner is unavailable. */
  private isExtensionCommand(handle: AgentHandle, text: string): boolean {
    if (!text.startsWith("/")) return false;
    const spaceIdx = text.indexOf(" ");
    const name = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
    if (!name) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = (handle.session as any)._extensionRunner;
    if (!runner || typeof runner.getCommand !== "function") return false;
    try {
      return Boolean(runner.getCommand(name));
    } catch {
      return false;
    }
  }

  /** Current fast-mode badge state per model. Used to prime newly-connected
   *  WS clients; empty if no fast-mode-capable provider has reported in. */
  getFastModeSnapshot(): FastModeSnapshot {
    return this.fastMode.snapshot();
  }

  /** Handle a `pi:fast-mode` event from the shared extension bus
   *  (pi-cas-provider / pi-hawk-provider). Folds it into the per-model
   *  tracker and broadcasts the new snapshot to all dashboard clients.
   *
   *  Every request a fast-mode-capable provider routes emits one of these,
   *  including the ones agents don't make themselves — notably the auto-mode
   *  extension's per-tool-call classifier, which runs on a model that can't do
   *  fast tier. Keying by model is what stops those from clearing the badge
   *  of an agent that *is* running fast. */
  private handleFastModeEvent(data: unknown): void {
    const applied = this.fastMode.apply(data);
    if (!applied) return;
    const { state, snapshot } = applied;
    console.log(
      `[agent-manager] fast-mode update: intent=${state.intent} actual=${state.actual ?? "?"} model=${state.model ?? "(toggle)"}`,
    );
    this.broadcastWs({ kind: "fast_mode", snapshot });
  }

  /** Live stats pulled from the pi session, matching the data pi's TUI
   *  footer shows: cumulative tokens, cost, context usage (% of window),
   *  model, thinking level, and compaction-aware status. Returns null if
   *  the agent isn't currently running. */
  getLiveStats(id: string): null | {
    model: { provider: string; id: string; contextWindow: number; reasoning: boolean } | null;
    thinkingLevel: string;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    /** `null` just after compaction, before the next LLM response tells us the new size. */
    contextTokens: number | null;
    contextWindow: number;
    /** null when `contextTokens` is null. */
    contextPercent: number | null;
    /** Number of turns / assistant messages. */
    turns: number;
    /** Session file on disk. Useful for debugging / `/resume`. */
    sessionFile: string | undefined;
  } {
    const handle = this.handles.get(id);
    if (!handle) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = handle.session as any;
    try {
      const stats = session.getSessionStats();
      const ctx = session.getContextUsage?.();
      const model = session.model ?? session.agent?.state?.model ?? null;
      const thinkingLevel = session.thinkingLevel ?? session.agent?.state?.thinkingLevel ?? "off";
      return {
        model: model
          ? {
              provider: model.provider,
              id: model.id,
              contextWindow: model.contextWindow ?? 0,
              reasoning: !!model.reasoning,
            }
          : null,
        thinkingLevel,
        tokens: stats.tokens,
        cost: stats.cost,
        contextTokens: ctx?.tokens ?? null,
        contextWindow: ctx?.contextWindow ?? model?.contextWindow ?? 0,
        contextPercent: ctx?.percent ?? null,
        turns: stats.assistantMessages,
        sessionFile: stats.sessionFile,
      };
    } catch (err) {
      console.error(`[agent-manager] getLiveStats for ${id} failed: ${err}`);
      return null;
    }
  }

  /** Get formatted chat messages from a running agent's session. */
  /** Flat list of every model the registry currently knows about, sorted
   *  by provider then id. Drives the model picker in the agent header.
   *  Each entry includes the bits the UI needs (context window, reasoning
   *  flag) plus a `qualifiedId` of `"<provider>/<id>"` for round-trips. */
  async listAvailableModels(): Promise<
    Array<{
      qualifiedId: string;
      provider: string;
      id: string;
      contextWindow: number;
      reasoning: boolean;
    }>
  > {
    // Ensure extensions are loaded (providers registered) and the
    // modelRuntime/modelRegistry exist before we read from them.
    await this.ensureResourceLoader();
    try {
      const models = this.modelRegistry.getAvailable();
      return models
        .map((m) => ({
          qualifiedId: `${m.provider}/${m.id}`,
          provider: m.provider,
          id: m.id,
          contextWindow: m.contextWindow,
          reasoning: m.reasoning,
        }))
        .sort((a, b) =>
          a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
        );
    } catch (err) {
      console.error(`[agent-manager] listAvailableModels failed: ${err}`);
      return [];
    }
  }

  /** Change the model an agent is using. Persists the new model string on
   *  the agent config (so resumes pick it up) and, if the session is live,
   *  switches it via pi's `session.setModel()` so the next turn uses the
   *  new model immediately. Throws if the model isn't registered. */
  async setAgentModel(id: string, qualifiedId: string): Promise<void> {
    await this.ensureResourceLoader();
    return this.withAgentLock(id, async () => {
      const slash = qualifiedId.indexOf("/");
      if (slash < 0) {
        throw new Error(`Model id must be "<provider>/<id>" (got "${qualifiedId}")`);
      }
      const provider = qualifiedId.slice(0, slash);
      const modelId = qualifiedId.slice(slash + 1);

      // Resolve against the registry. Custom providers (hawk) often have
      // empty `models: []` so we fall back to the discovered list.
      let model = this.modelRegistry.find(provider, modelId) ?? undefined;
      if (!model) {
        const available = this.modelRegistry.getAvailable();
        model = available.find((m) => m.provider === provider && m.id === modelId);
      }
      if (!model) {
        throw new Error(`Model "${qualifiedId}" not found in the registry.`);
      }

      const config = this.getAgent(id);
      if (!config) throw new Error(`Agent ${id} not found`);

      // Update persisted state first so resumes use the new model. Then
      // mutate the live session if any — pi's setModel re-validates auth
      // and updates session settings; failures here are surfaced.
      this.stateManager.updateAgentState(id, { model: qualifiedId });
      config.model = qualifiedId;

      const handle = this.handles.get(id);
      if (handle) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (handle.session as any).setModel(model);
        // Re-derive the compaction threshold for the new model's window.
        this.applyCompactionSettings(handle.settingsManager, model, config.name);
        console.log(`[agent-manager] live setModel ${id} -> ${qualifiedId}`);
      } else {
        console.log(`[agent-manager] config-only setModel ${id} -> ${qualifiedId} (no live session)`);
      }

      // Broadcast a lightweight state-change so the UI re-renders the
      // header. We don't actually transition lifecycle, but reusing the
      // same channel keeps the wiring simple.
      this.emitStateChange(id, config.state);
    });
  }

  /** Change the thinking level for an agent. Mirrors setAgentModel:
   *  persists on the agent config (so resumes pick it up) and, if the
   *  session is live, updates pi's reasoning settings via
   *  `session.setThinkingLevel()` so the next turn uses the new level
   *  immediately. Allowed values: "off" | "minimal" | "low" | "medium" |
   *  "high" | "xhigh". Levels above "off" only have effect on models
   *  with reasoning support; pi silently ignores them on non-reasoning
   *  models. */
  async setAgentThinkingLevel(
    id: string,
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  ): Promise<void> {
    return this.withAgentLock(id, async () => {
      const config = this.getAgent(id);
      if (!config) throw new Error(`Agent ${id} not found`);

      // Apply to the live session first (if any). Pi's `setThinkingLevel`
      // consults `getAvailableThinkingLevels()` for the current model and
      // CLAMPS the request to the nearest supported level (e.g. "xhigh"
      // becomes "high" on a model whose provider didn't declare a
      // `thinkingLevelMap` entry for "xhigh"). The clamp is silent.
      //
      // Persist whatever pi actually accepted, not what the user asked
      // for. Otherwise the footer's left column shows the requested
      // level (read from our persisted state) while the right column
      // shows the live session level (clamped) -- and they disagree.
      // See provider-side fix: pi-cas-provider commit propagating
      // `thinkingLevelMap`; the same fix landed in pi-hawk-provider
      // earlier. This branch defends in depth against any future
      // provider that legitimately doesn't support the requested level.
      const handle = this.handles.get(id);
      let effectiveLevel = level;
      if (handle) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = handle.session as any;
        session.setThinkingLevel(level);
        const readback = session.thinkingLevel ?? session.agent?.state?.thinkingLevel;
        if (typeof readback === "string" && readback !== level) {
          console.log(
            `[agent-manager] live setThinkingLevel ${id}: requested ${level}, model accepted ${readback} (clamped)`,
          );
          effectiveLevel = readback as typeof level;
        } else {
          console.log(`[agent-manager] live setThinkingLevel ${id} -> ${level}`);
        }
      } else {
        console.log(`[agent-manager] config-only setThinkingLevel ${id} -> ${level} (no live session)`);
      }
      this.stateManager.updateAgentState(id, { thinkingLevel: effectiveLevel });
      config.thinkingLevel = effectiveLevel;

      // Same lightweight rerender broadcast as setAgentModel.
      this.emitStateChange(id, config.state);
    });
  }

  getMessages(id: string): ChatMessage[] {
    const handle = this.handles.get(id);
    let messages: ReadonlyArray<unknown>;
    let source: string;
    if (handle) {
      messages = handle.session.messages;
      source = "live";
    } else {
      // Agent isn't running (stopped, errored, or never started). Pi's
      // CLI behaves the same as us when the agent IS running -- but
      // unlike pi, our "stop" doesn't keep the session alive in memory.
      // We tear it down so a stopped agent costs nothing.
      //
      // To preserve the conversation across a stop (matches pi-CLI's
      // Ctrl+C-interrupt semantics: the transcript stays put), load the
      // most-recent session from disk via SessionManager.continueRecent.
      // We DON'T mutate any state -- just walk the entries to extract
      // messages for the UI.
      const config = this.stateManager.getAgent(id);
      if (!config || !config.sessionDir) {
        return [];
      }
      try {
        const sm = SessionManager.continueRecent(config.worktreePath, config.sessionDir);
        // buildSessionContext() resolves compaction summaries into the
        // canonical message list, same as what an active session would
        // hand the LLM. That's exactly what we want to render.
        messages = sm.buildSessionContext().messages;
        source = "disk";
      } catch (err) {
        console.log(`[agent-manager] getMessages: no on-disk session for ${id}: ${err instanceof Error ? err.message : err}`);
        return [];
      }
    }
    console.log(
      `[agent-manager] getMessages for ${id}: ${messages.length} raw messages (source=${source})`,
    );
    const result: ChatMessage[] = [];

    for (const rawMsg of messages) {
      const msg = rawMsg as {
        role: string;
        content: unknown;
        timestamp: number;
        stopReason?: string;
        errorMessage?: string;
        toolName?: string;
        toolCallId?: string;
        isError?: boolean;
      };
      if (msg.role === "user") {
        // User messages can have a string or an array of content blocks.
        // Array form is what pi uses when there are images attached.
        // Extract text + images independently so the UI can render both.
        let content = "";
        const images = pickImageContent(msg.content);
        if (typeof msg.content === "string") {
          content = msg.content;
        } else {
          content = (msg.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
        }
        result.push({
          role: "user",
          content,
          ts: msg.timestamp,
          ...(images.length > 0 ? { images } : {}),
        });
      } else if (msg.role === "assistant") {
        // Extract thinking, text, and tool-calls separately so the UI can
        // render them as their own timeline entries.
        const thinkingParts: string[] = [];
        const textParts: string[] = [];
        const blocks = msg.content as Array<Record<string, unknown>>;
        for (const block of blocks) {
          if ("type" in block && block.type === "thinking" && "thinking" in block) {
            thinkingParts.push(block.thinking as string);
          } else if ("type" in block && block.type === "text" && "text" in block) {
            textParts.push(block.text as string);
          } else if ("type" in block && block.type === "toolCall") {
            const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
            result.push({
              role: "tool",
              content: `▶ ${tc.name}`,
              toolName: tc.name,
              toolCallId: tc.id,
              args: tc.arguments,
              ts: msg.timestamp,
            });
          }
        }
        if (thinkingParts.length > 0) {
          result.push({
            role: "thinking",
            content: thinkingParts.join("\n"),
            ts: msg.timestamp,
          });
        }
        if (textParts.length > 0) {
          result.push({
            role: "assistant",
            content: textParts.join("\n"),
            ts: msg.timestamp,
          });
        }
        // Surface API errors
        if (msg.stopReason === "error" && msg.errorMessage) {
          result.push({
            role: "system",
            content: `Error: ${msg.errorMessage}`,
            ts: msg.timestamp,
          });
        }
      } else if (msg.role === "toolResult") {
        const textContent = (msg.content as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n");
        // Truncate long tool output for the chat view
        const truncated =
          textContent.length > 2000
            ? textContent.slice(0, 2000) + "\n…(truncated)"
            : textContent;
        // Tool results can also include images (e.g. a screenshot tool).
        const images = pickImageContent(msg.content);
        result.push({
          role: "tool_result",
          content: truncated || (msg.isError ? "✗ error" : "✓ done"),
          toolName: msg.toolName,
          toolCallId: msg.toolCallId,
          isError: msg.isError,
          ts: msg.timestamp,
          ...(images.length > 0 ? { images } : {}),
        });
      } else if (msg.role === "compactionSummary") {
        result.push({
          role: "system",
          content: "[context compacted]",
          ts: msg.timestamp,
        });
      }
      // Skip bashExecution, branchSummary, custom, thinking — not needed in chat
    }

    return result;
  }

  /** Create a brand-new agent and start its pi session.
   *
   *  An agent always belongs to a project (defaults to DEFAULT_PROJECT_NAME).
   *  The agent gets its own git worktree under the project's repo, on
   *  branch `agent/<slug>` — so multiple agents can work on the project
   *  concurrently without stepping on each other.
   *
   *  Lifecycle states emitted via WebSocket:
   *    starting → idle (success)
   *    starting → error (worktree create or session start failed)
   */
  async createAgent(opts: {
    name: string;
    projectName?: string;
    model?: string;
    thinkingLevel?: string;
  }): Promise<AgentConfig> {
    const trimmedName = opts.name.trim();
    if (!trimmedName) throw new Error("agent name is required");

    // Resolve the project first — we refuse to create an agent against a
    // non-existent project. This means the default scratchpad must have
    // been initialized by now (server startup does this).
    const projectName = opts.projectName ?? DEFAULT_PROJECT_NAME;
    const project = this.projectManager.getProject(projectName);
    if (!project) {
      throw new Error(
        `project "${projectName}" not found. Use \`pru project add ${projectName}\` first.`,
      );
    }

    const id = randomUUID().slice(0, 8);
    const slug = this.agentSlug(trimmedName, id);
    const sessionDir = this.agentSessionDir(trimmedName, id);

    return this.withAgentLock(id, async () => {
      await mkdir(sessionDir, { recursive: true });

      const now = new Date().toISOString();
      // Persist the config BEFORE worktree creation so the UI can see the
      // agent (and its error message if creation fails).
      const config: AgentConfig = {
        id,
        name: trimmedName,
        projectName,
        worktreePath: "", // filled in below
        branchName: null, // filled in below
        sessionDir,
        state: "starting",
        createdAt: now,
        lastActivity: now,
        model: opts.model ?? null,
        // Apply the server-side default thinking level if the caller didn't
         // pass one. `@<newname>` quick-creates from the web UI hit this
         // path; the CLI's `pru launch` can override via --thinking.
        thinkingLevel: opts.thinkingLevel || process.env.PIROUETTE_DEFAULT_THINKING_LEVEL || "off",
        usage: emptyUsage(),
        errorMessage: null,
      };
      this.stateManager.putAgent(config);

      // Create the worktree. Projects always have a git repo (scratchpad
      // gets `git init`'d at project creation) so `createWorktree` works
      // uniformly.
      try {
        const base = project.defaultBranch ?? "main";
        const wt = await createWorktree({
          repoPath: project.repoPath,
          worktreesDir: project.worktreesDir,
          slug,
          baseBranch: base,
        });
        config.worktreePath = wt.path;
        config.branchName = wt.branch;
        this.stateManager.updateAgentState(id, {
          worktreePath: wt.path,
          branchName: wt.branch,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.markError(config, `worktree create failed: ${msg}`);
        throw err;
      }

      try {
        await this.startSession(config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.markError(config, msg);
        throw err;
      }
      return config;
    });
  }

  /** Fork an existing agent into a new one with a copy of its session.
   *
   *  Mechanics:
   *    1. Locate the parent's most recent session file (uses the live
   *       session if running, otherwise scans the parent's session dir).
   *    2. Allocate a new agent in the parent's project, with its own slug,
   *       worktree, and session dir. Branch is created off the parent's
   *       branch tip so the working state matches.
   *    3. Use `SessionManager.forkFrom()` to copy the parent's JSONL into
   *       the child's session dir. This duplicates conversation history.
   *    4. Bring up the child via `startSession` with the forked manager.
   *    5. If `entryId` is provided, navigate the new session back to that
   *       point so the fork starts from a specific message rather than at
   *       HEAD. Useful for "try a different direction from message N".
   *
   *  The original agent is untouched. Both agents can run concurrently.
   *  Tracks the parent via `parentAgentId` for tree visualization. */
  async forkAgent(
    parentId: string,
    opts: { name?: string; entryId?: string } = {},
  ): Promise<AgentConfig> {
    const parent = this.getAgent(parentId);
    if (!parent) throw new Error(`Parent agent ${parentId} not found`);

    // Find the parent's session file. Prefer the live one (most recent
    // state); fall back to the latest JSONL on disk.
    const parentHandle = this.handles.get(parentId);
    let parentSessionFile = parentHandle?.session.sessionFile ?? null;
    if (!parentSessionFile) {
      try {
        const files = await readdir(parent.sessionDir);
        const jsonl = files.filter((f) => f.endsWith(".jsonl")).sort();
        if (jsonl.length > 0) {
          parentSessionFile = path.join(parent.sessionDir, jsonl[jsonl.length - 1]);
        }
      } catch {
        // sessionDir may not exist for an agent that never ran
      }
    }
    if (!parentSessionFile) {
      throw new Error(
        `Cannot fork agent "${parent.name}": no session file found. ` +
          `Send at least one message before forking.`,
      );
    }

    // Project must still exist (rare but possible if it was deleted while
    // the parent was orphaned).
    const project = this.projectManager.getProject(parent.projectName);
    if (!project) {
      throw new Error(`Project "${parent.projectName}" not found.`);
    }

    const id = randomUUID().slice(0, 8);
    const name = (opts.name ?? `${parent.name}-fork`).trim();
    const slug = this.agentSlug(name, id);
    const sessionDir = this.agentSessionDir(name, id);

    return this.withAgentLock(id, async () => {
      await mkdir(sessionDir, { recursive: true });

      const now = new Date().toISOString();
      const config: AgentConfig = {
        id,
        name,
        projectName: parent.projectName,
        worktreePath: "",
        branchName: null,
        sessionDir,
        state: "starting",
        createdAt: now,
        lastActivity: now,
        model: parent.model,
        thinkingLevel: parent.thinkingLevel,
        usage: emptyUsage(),
        errorMessage: null,
        parentAgentId: parent.id,
      };
      this.stateManager.putAgent(config);

      // Worktree off the parent's current branch (or default if parent has
      // none, e.g. scratchpad agents). Same collision-suffix scheme as
      // `createAgent`.
      try {
        const baseBranch = parent.branchName ?? project.defaultBranch ?? "main";
        const wt = await createWorktree({
          repoPath: project.repoPath,
          worktreesDir: project.worktreesDir,
          slug,
          baseBranch,
        });
        config.worktreePath = wt.path;
        config.branchName = wt.branch;
        this.stateManager.updateAgentState(id, {
          worktreePath: wt.path,
          branchName: wt.branch,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.markError(config, `worktree create failed: ${msg}`);
        throw err;
      }

      // Fork the session itself. `forkFrom` copies the parent's JSONL
      // into a new file in the child's session dir and returns a manager
      // bound to it. The child gets the full conversation history.
      try {
        const sessionManager = SessionManager.forkFrom(
          parentSessionFile!,
          config.worktreePath,
          config.sessionDir,
        );
        await this.startSession(config, { sessionManager });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.markError(config, `session fork failed: ${msg}`);
        throw err;
      }

      // Optional: navigate to a specific entry to truncate the forked
      // session. Done after startSession so we have a live handle. Failure
      // here is non-fatal — the user just gets the full forked history.
      if (opts.entryId) {
        const handle = this.handles.get(id);
        if (handle) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (handle.session as any).navigateTree(opts.entryId, {
              summarize: false,
            });
          } catch (err) {
            console.error(`[agent-manager] navigateTree failed for fork ${id}: ${err}`);
          }
        }
      }

      return config;
    });
  }

  /** Hand an agent's work over to a fresh agent in the same worktree.
   *
   *  The successor is a new chat with an empty context that adopts the
   *  parent's project, worktree, branch, model and thinking level. Nothing
   *  is copied from the conversation — the *worktree* is the shared state,
   *  plus whatever briefing the caller passes as `message`. That's the whole
   *  point: a handoff exists to escape a context that has become long,
   *  stale, or expensive, so a fork (which copies the history) is exactly
   *  the wrong tool.
   *
   *  Mechanics:
   *    1. Allocate the successor, pointing `worktreePath` / `branchName` at
   *       the parent's. No new worktree is created, so uncommitted work,
   *       untracked scratch files, build caches and the checked-out branch
   *       all carry over untouched.
   *    2. Start its session (`resume: false` → empty context).
   *    3. Archive the parent, so the sidebar shows one live chat, not two.
   *    4. Send the briefing to the successor (fire-and-forget; the turn can
   *       run for minutes).
   *    5. Stop the parent after a short grace period. The grace period
   *       matters when the *parent itself* triggered the handoff: it is
   *       mid-tool-call, and tearing its session down synchronously would
   *       kill the very bash/HTTP call that asked for this.
   *
   *  Two agents briefly share one worktree (between steps 1 and 5), which is
   *  why the parent is stopped rather than left idle. `removeAgent` refuses
   *  to delete a worktree another agent still points at.
   */
  async handoffAgent(
    parentId: string,
    opts: { name?: string; message?: string; stopParentDelayMs?: number } = {},
  ): Promise<AgentConfig> {
    const parent = this.getAgent(parentId);
    if (!parent) throw new Error(`Agent ${parentId} not found`);
    if (!parent.worktreePath) {
      throw new Error(`Cannot hand off agent "${parent.name}": it has no worktree.`);
    }
    const project = this.projectManager.getProject(parent.projectName);
    if (!project) {
      throw new Error(`Project "${parent.projectName}" not found.`);
    }

    const id = randomUUID().slice(0, 8);
    const name = (opts.name ?? nextHandoffName(parent.name)).trim();
    const sessionDir = this.agentSessionDir(name, id);

    const successor = await this.withAgentLock(id, async () => {
      await mkdir(sessionDir, { recursive: true });
      const now = new Date().toISOString();
      const config: AgentConfig = {
        id,
        name,
        projectName: parent.projectName,
        // Deliberately the parent's worktree, not a new one.
        worktreePath: parent.worktreePath,
        branchName: parent.branchName,
        sessionDir,
        state: "starting",
        createdAt: now,
        lastActivity: now,
        model: parent.model,
        thinkingLevel: parent.thinkingLevel,
        usage: emptyUsage(),
        errorMessage: null,
        parentAgentId: parent.id,
      };
      this.stateManager.putAgent(config);

      try {
        await this.startSession(config, { resume: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.markError(config, msg);
        throw err;
      }
      return config;
    });

    console.log(
      `[agent-manager] handoff ${parent.name} (${parentId}) -> ${name} (${id}) ` +
        `in ${parent.worktreePath}`,
    );

    // Archive the parent. Its transcript stays on disk and stays readable
    // behind the dashboard's "show archived" toggle.
    if (!parent.archived) {
      this.setArchived(parentId, true);
      const updated = this.stateManager.getAgent(parentId);
      if (updated) {
        this.broadcastWs({
          kind: "agent_updated",
          agentId: parentId,
          agent: { ...updated, running: this.handles.has(parentId) },
        });
      }
    }

    if (opts.message) {
      this.sendMessage(id, opts.message).catch((err) => {
        console.error(`[agent-manager] handoff briefing failed for ${id}: ${err}`);
      });
    }

    const delay = opts.stopParentDelayMs ?? HANDOFF_PARENT_STOP_DELAY_MS;
    const stopParent = () =>
      this.stopAgent(parentId).catch((err) => {
        console.error(`[agent-manager] stopping handed-off agent ${parentId} failed: ${err}`);
      });
    if (delay > 0) {
      const timer = setTimeout(stopParent, delay);
      if (typeof timer.unref === "function") timer.unref();
    } else {
      await stopParent();
    }

    return successor;
  }

  /** List user messages in an agent's session that can serve as fork
   *  points. Returns `[{ entryId, text }]` ordered as they appear in the
   *  session. Driven by pi's `getUserMessagesForForking()`. Empty when
   *  the agent isn't running (we'd need to read from disk — deferred). */
  getForkPoints(id: string): Array<{ entryId: string; text: string }> {
    const handle = this.handles.get(id);
    if (!handle) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (handle.session as any).getUserMessagesForForking() ?? [];
    } catch {
      return [];
    }
  }

  /** Resume agents on server startup. Skips only agents the *user*
   *  stopped (state "stopped"). Agents stopped by the previous server
   *  shutdown carry state "shutdown" and are resumed, as is anything
   *  else ("running", "idle", ... — e.g. left behind by a crash).
   *
   *  Two nudges get dispatched from here so a restart (notably
   *  `pru self-update`) doesn't leave a wall of parked agents:
   *
   *    - agents that were mid-turn get "your turn was interrupted,
   *      continue" (see autoContinueAfterResume),
   *    - the agent that *triggered* a self-update gets "the update landed"
   *      even though its turn had already ended while the installer ran
   *      (see the restart notice module).
   *
   *  A resume that fails (transient provider/token errors are common in
   *  the first seconds after a restart) is retried in the background
   *  instead of parking the agent in "error" forever. */
  async resumeAll(): Promise<void> {
    // Ensure extensions are loaded up-front so the model registry is populated.
    await this.ensureResourceLoader();
    const notice = this.takeRestartNotice();
    const agents = this.stateManager.getAgents();
    for (const config of agents) {
      if (config.state === "stopped") continue;
      // Was the agent mid-turn when the server went down? Two signals:
      //   - graceful shutdown recorded `interruptedTurn` (state is now
      //     "shutdown"), or
      //   - a crash left the live "running" state on disk.
      // Snapshot BEFORE resumeAgent(), which overwrites state.
      const wasMidTurn = config.interruptedTurn === true || config.state === "running";
      // Did this agent ask for the update we just came back from? Match on
      // the session dir, which is 1:1 with an agent.
      const isUpdateInitiator =
        !!notice?.sessionDir &&
        path.resolve(notice.sessionDir) === path.resolve(config.sessionDir);
      try {
        await this.resumeAgent(config.id);
      } catch (err) {
        console.error(`[agent-manager] failed to resume agent ${config.name}: ${err}`);
        this.markError(
          config,
          `resume failed: ${err instanceof Error ? err.message : err}`,
        );
        this.scheduleResumeRetry(config.id, {
          wasMidTurn,
          updateNotice: isUpdateInitiator ? notice : undefined,
          attempt: 1,
        });
        continue;
      }
      if (wasMidTurn) {
        // NB: `interruptedTurn` is intentionally NOT cleared here. It is
        // cleared once the nudge has actually been delivered, so a boot
        // that dies (or a nudge that can't be dispatched) retries on the
        // next boot instead of silently dropping the agent's work.
        this.autoContinueAfterResume(config.id);
      } else {
        if (config.interruptedTurn) {
          this.stateManager.updateAgentState(config.id, { interruptedTurn: false });
        }
        if (isUpdateInitiator) {
          this.autoContinueAfterResume(config.id, {
            message: selfUpdateResumeMessage(notice ?? undefined),
            reason: "self-update",
          });
        }
      }
    }
  }

  /** Read (and delete) the note `pru self-update` leaves behind naming the
   *  agent that triggered the update. Best-effort: never throws, and a
   *  stale note (failed update that never restarted us) is ignored. */
  private takeRestartNotice(): RestartNotice | null {
    try {
      const notice = consumeRestartNotice(this.dataDir);
      if (notice) {
        console.log(
          `[agent-manager] self-update notice found (requested ${notice.requestedAt}` +
            `${notice.sessionDir ? `, initiator session ${notice.sessionDir}` : ", no initiating agent"})`,
        );
      }
      return notice;
    } catch (err) {
      console.error(`[agent-manager] failed to read self-update notice: ${err}`);
      return null;
    }
  }

  /** Retry a failed resume in the background with a widening backoff.
   *
   *  A restart can land while the machine is still settling (auth token
   *  refresh, network, a slow model registry). Before this, a single
   *  failure parked the agent in "error" until a human noticed. */
  private scheduleResumeRetry(
    id: string,
    opts: { wasMidTurn: boolean; updateNotice?: RestartNotice | null; attempt: number },
  ): void {
    const delay = RESUME_RETRY_DELAYS_MS[opts.attempt - 1];
    if (delay === undefined) {
      console.error(`[agent-manager] giving up resuming ${id} after ${opts.attempt - 1} retries`);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        // The user may have stopped/removed the agent in the meantime.
        const cfg = this.stateManager.getAgent(id);
        if (!cfg || cfg.state === "stopped") return;
        if (this.handles.has(id)) return; // came back some other way
        console.log(`[agent-manager] retrying resume for ${id} (attempt ${opts.attempt})`);
        try {
          await this.resumeAgent(id);
        } catch (err) {
          console.error(`[agent-manager] resume retry ${opts.attempt} failed for ${id}: ${err}`);
          this.scheduleResumeRetry(id, { ...opts, attempt: opts.attempt + 1 });
          return;
        }
        this.stateManager.updateAgentState(id, { errorMessage: null });
        if (opts.wasMidTurn) {
          this.autoContinueAfterResume(id);
        } else if (opts.updateNotice) {
          this.autoContinueAfterResume(id, {
            message: selfUpdateResumeMessage(opts.updateNotice),
            reason: "self-update",
          });
        }
      })();
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
  }

  /** Re-kick an agent after a restart.
   *
   *  A resumed session is restored with full history but pi does NOT
   *  re-run the aborted turn -- the agent lands in `waiting_input` and
   *  stalls. This injects a short user turn telling it to continue, so a
   *  restart (self-update, reboot, crash) actually *resumes the work*,
   *  not just the session.
   *
   *  Fire-and-forget by design: we kick off delivery but do NOT await the
   *  turn, so resumeAll() doesn't serialize on every agent's work.
   *  Opt out with PIROUETTE_RESUME_AUTOCONTINUE=0 (agents then just sit at
   *  waiting_input, the pre-feature behaviour). */
  private autoContinueAfterResume(
    id: string,
    opts: { message?: string; reason?: string } = {},
  ): void {
    if (process.env.PIROUETTE_RESUME_AUTOCONTINUE === "0") {
      console.log(`[agent-manager] auto-continue disabled; ${id} left at waiting_input`);
      return;
    }
    const message =
      opts.message ||
      process.env.PIROUETTE_RESUME_CONTINUE_MESSAGE?.trim() ||
      DEFAULT_RESUME_CONTINUE_MESSAGE;
    void this.deliverResumeNudge(id, message, opts.reason ?? "interrupted-turn");
  }

  /** Deliver a post-restart nudge, retrying transient dispatch failures.
   *
   *  Right after a restart the provider stack can still be waking up (auth
   *  token refresh, model registry, network), and a single rejected
   *  `prompt()` used to be fatal: the agent got marked "error" and never
   *  continued its work. We retry a few times, and only clear
   *  `interruptedTurn` once a turn was actually accepted -- if we never
   *  manage it, the flag survives so the NEXT boot tries again.
   *
   *  Gives up immediately (without clearing the flag) when the agent is no
   *  longer running or a human has taken over: a user stop or a manual
   *  message means the nudge is unwanted. */
  private async deliverResumeNudge(id: string, message: string, reason: string): Promise<void> {
    for (let attempt = 0; attempt < NUDGE_ATTEMPT_DELAYS_MS.length; attempt++) {
      const delay = NUDGE_ATTEMPT_DELAYS_MS[attempt];
      if (delay > 0) await sleep(delay);

      const handle = this.handles.get(id);
      if (!handle) {
        console.log(`[agent-manager] auto-continue for ${id} skipped: agent is not running`);
        return;
      }
      // Nothing to continue if the session has no history (shouldn't happen
      // for a mid-turn agent, but guard anyway). Logged: a silent bail here
      // is indistinguishable from "the feature didn't run" when you're
      // reading logs after a restart, which cost real debugging time.
      if (handle.session.messages.length === 0) {
        console.log(`[agent-manager] auto-continue for ${id} skipped: session has no history`);
        this.clearInterruptedTurn(id);
        return;
      }
      // A human (or another client) got there first — don't pile on.
      if (handle.session.isStreaming) {
        console.log(`[agent-manager] auto-continue for ${id} skipped: already streaming`);
        this.clearInterruptedTurn(id);
        return;
      }

      console.log(
        `[agent-manager] auto-continuing ${handle.config.name} (${id}), reason=${reason}` +
          (attempt > 0 ? `, retry ${attempt}` : ""),
      );
      this.setAgentState(id, "running");
      try {
        await handle.session.prompt(message);
        console.log(`[agent-manager] auto-continue turn finished for ${id}`);
        this.clearInterruptedTurn(id);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[agent-manager] auto-continue attempt ${attempt + 1} failed for ${id}: ${msg}`);
        // An abort means someone deliberately stopped this turn (user hit
        // stop, or we're shutting down again). Don't fight them.
        if (/abort/i.test(msg)) {
          this.clearInterruptedTurn(id);
          return;
        }
        const cfg = this.stateManager.getAgent(id);
        const isLast = attempt === NUDGE_ATTEMPT_DELAYS_MS.length - 1;
        if (isLast && cfg) {
          // Leave the agent usable (waiting_input, not "error") and keep
          // interruptedTurn set so the next boot retries the nudge.
          this.stateManager.updateAgentState(id, {
            errorMessage: `auto-continue after resume failed: ${msg}`,
            interruptedTurn: true,
          });
        }
        // Don't leave the dashboard showing "running" while we wait out
        // the backoff (or after giving up).
        this.setAgentState(id, "waiting_input");
      }
    }
  }

  /** Mark an agent's interrupted turn as dealt with (persisted so a later
   *  boot doesn't re-nudge). */
  private clearInterruptedTurn(id: string): void {
    const cfg = this.stateManager.getAgent(id);
    if (!cfg || cfg.interruptedTurn !== true) return;
    this.stateManager.updateAgentState(id, { interruptedTurn: false });
  }

  /** Resume a specific agent by id. */
  async resumeAgent(id: string): Promise<void> {
    return this.withAgentLock(id, async () => {
      if (this.handles.has(id)) return; // already running
      const config = this.stateManager.getAgent(id);
      if (!config) throw new Error(`Agent ${id} not found`);

      await mkdir(config.worktreePath, { recursive: true });
      await mkdir(config.sessionDir, { recursive: true });
      await this.startSession(config, { resume: true });
    });
  }

  /** Send a message to a running agent.
   *
   *  When the agent is idle: starts a new turn (`prompt`).
   *  When the agent is currently streaming, the caller chooses how the
   *  message is delivered:
   *
   *    - `"steer"` (default): interrupt the current turn and inject the
   *      message as a new user prompt. Matches pi's TUI default — use when
   *      you want to course-correct mid-stream.
   *    - `"followUp"`: queue for after the current turn finishes
   *      naturally. Use when you want to add work without interrupting.
   *
   *  Both produce `queue_update` events the UI can render to show pending
   *  steering / follow-up messages. */
  async sendMessage(
    id: string,
    message: string,
    opts: {
      mode?: "steer" | "followUp";
      /** Image attachments forwarded to pi's prompt/steer/followUp.
       *  Pi's `ImageContent` shape is `{ type: "image", data, mimeType }`;
       *  callers pass us the raw `{ data, mimeType }` and we wrap. */
      images?: Array<{ data: string; mimeType: string }>;
    } = {},
  ): Promise<void> {
    // Critical: do NOT hold the agent lock across `await session.prompt()`.
    //
    // pi.session.prompt() returns a promise that doesn't resolve until the
    // ENTIRE turn ends (agent_end fires). If we awaited it inside the lock,
    // any subsequent sendMessage call -- including the one the user types
    // mid-turn to steer the agent -- would block on the lock until the
    // current turn finishes. By the time the lock releases, isStreaming
    // is false, and the steer-intent message takes the `prompt()` branch
    // instead of `steer()`. The user sees "steer behaves like follow-up".
    //
    // So we use the lock only for the brief critical section that decides
    // which pi API to invoke (and captures the prompt promise if we start
    // one). The long-lived prompt promise is awaited OUTSIDE the lock so
    // a follow-up sendMessage can race in mid-turn, take the lock, see
    // isStreaming=true, and dispatch via session.steer() (which is a quick
    // enqueue, not a blocking call).
    //
    // Same shape as stopAgent's pre-lock abort() trick: pi's APIs are
    // explicitly designed to be safe to call concurrently with prompt().
    const mode = opts.mode ?? "steer";
    const imageCount = opts.images?.length ?? 0;
    const images =
      imageCount > 0
        ? opts.images!.map((i) => ({
            type: "image" as const,
            data: i.data,
            mimeType: i.mimeType,
          }))
        : undefined;

    // Wrapper around the prompt promise. We can't just return the
    // promise itself from the lock closure: `withAgentLock` chains via
    // `prev.then(fn, fn)`, and JavaScript auto-flattens Promise<Promise<T>>,
    // which means returning a pending promise from `fn` would keep the
    // lock held until that promise settles -- defeating the whole point.
    // Boxing in a plain object defeats the flattening.
    const result = await this.withAgentLock(id, async (): Promise<{ promptPromise: Promise<void> } | null> => {
      const handle = this.handles.get(id);
      if (!handle) throw new Error(`Agent ${id} is not running`);

      console.log(
        `[agent-manager] sendMessage to ${handle.config.name} (${id}): streaming=${handle.session.isStreaming} mode=${mode}${imageCount > 0 ? ` images=${imageCount}` : ""}`,
      );
      // A message means the user is actively working in this chat, so it
      // shouldn't stay tucked away in the archive (they'd never see the
      // reply). No-op unless the chat is actually archived.
      this.unarchiveOnActivity(id);
      // Clear any prior error when the user sends a new message.
      if (handle.config.errorMessage) {
        this.stateManager.updateAgentState(id, { errorMessage: null });
        handle.config.errorMessage = null;
      }
      this.setAgentState(id, "running");

      // Pi's API quirk: prompt() takes options object `{images}`, but
      // steer/followUp take a plain `images` arg as the 2nd parameter.
      // Hidden in agent-session.d.ts -- see steer(text, images?) etc.
      //
      // steer() / followUp() are quick enqueues -- await them inside the
      // lock to surface errors before returning.
      if (handle.session.isStreaming) {
        // Extension commands (registered via pi.registerCommand, e.g.
        // `/fast`) cannot be queued: pi's steer()/followUp() throw
        // `Extension command "/x" cannot be queued`. They must go through
        // prompt(), which dispatches them immediately even mid-stream (pi
        // runs _tryExecuteExtensionCommand before the streaming-queue
        // branch). So route extension commands to prompt(); everything
        // else keeps the steer/followUp split. We box the prompt promise
        // and await it OUTSIDE the lock, same as the idle path -- the
        // command handler runs quickly and resolves it.
        if (this.isExtensionCommand(handle, message)) {
          console.log(
            `[agent-manager] dispatching extension command mid-stream via prompt: ${message}`,
          );
          return {
            promptPromise: handle.session.prompt(message, {
              streamingBehavior: mode,
              ...(images ? { images } : {}),
            }),
          };
        }
        if (mode === "followUp") {
          console.log(`[agent-manager] using followUp (agent is streaming)`);
          await handle.session.followUp(message, images);
        } else {
          console.log(`[agent-manager] using steer (agent is streaming)`);
          await handle.session.steer(message, images);
        }
        return null;
      }

      // prompt() returns a promise immediately (synchronously sets
      // isStreaming=true, then asynchronously runs the agent loop).
      // Box the promise so the lock chain doesn't await it; we await
      // outside the lock so steer calls can race in.
      console.log(`[agent-manager] using prompt (agent is idle)`);
      return {
        promptPromise: handle.session.prompt(message, images ? { images } : undefined),
      };
    });

    if (result) {
      try {
        await result.promptPromise;
        console.log(`[agent-manager] prompt resolved for ${id}`);
      } catch (err) {
        console.log(`[agent-manager] prompt rejected for ${id}: ${err}`);
        this.markPromptFailure(id, err);
        throw err;
      }
    } else {
      console.log(`[agent-manager] ${mode} enqueued for ${id}`);
    }
  }

  /** A `prompt()` that rejected without the turn ever starting (bad auth,
   *  an extension throwing in `before_agent_start`, ...) never produces an
   *  `agent_end` event, so nothing else moves the agent off the `running`
   *  state we set when the message was accepted. The agent then sits in the
   *  dashboard looking busy forever, having done nothing — and whoever sent
   *  the message (often another agent, via `pru send`) has no way to tell.
   *
   *  Park it in `error` with the reason instead. The next message clears it. */
  private markPromptFailure(id: string, err: unknown): void {
    const config = this.getAgent(id);
    if (!config) return;
    // Another turn is genuinely in flight (this rejection raced with a
    // steer that started a new one) — `running` is the honest state.
    if (this.handles.get(id)?.session.isStreaming) return;
    // Pi already ended the turn (`agent_end` → waiting_input): the turn did
    // run, so don't overwrite what the event stream reported.
    if (config.state !== "running") return;
    this.markError(config, err instanceof Error ? err.message : String(err));
  }

  /** Interrupt whatever the agent is doing right now, WITHOUT tearing the
   *  session down. This is the dashboard's Escape key, and the analogue of
   *  hitting Escape in pi's TUI:
   *
   *    - streaming turn (or auto-retry backoff) → drop the pending
   *      steering / follow-up queue and `session.abort()` the turn. Pi
   *      fires the AbortSignal the LLM call and any running tool are
   *      listening on, then emits `agent_end`, which flips our state
   *      machine to `waiting_input`.
   *    - compaction in flight → `session.abortCompaction()`.
   *    - session-level bash (`!cmd`) running → `session.abortBash()`.
   *
   *  Contrast with `stopAgent()`, which disposes the pi session entirely
   *  and parks the agent in `stopped` until someone resumes it. After an
   *  interrupt the agent is still live and ready for the next message --
   *  the conversation just stops mid-turn.
   *
   *  No agent lock, for the same reason `stopAgent()` fires its pre-lock
   *  abort and `compactAgent()` skips the lock entirely: `sendMessage()`
   *  is (deliberately) not holding the lock across the streaming turn, but
   *  it does take it in short bursts, and cancellation must not queue
   *  behind anything. Pi's abort APIs are explicitly safe to call
   *  concurrently with `prompt()`.
   *
   *  Throws if the agent isn't running (nothing to interrupt). Returns a
   *  summary the caller can surface: what got cancelled, and any queued
   *  messages we dropped (the dashboard puts those back in the composer,
   *  matching pi's TUI). */
  async interruptAgent(id: string): Promise<InterruptResult> {
    const handle = this.handles.get(id);
    if (!handle) throw new Error(`Agent ${id} is not running`);
    // Pi's abort surface beyond `abort()` / `isStreaming` isn't on the
    // public typings we pin against in every version, and an extension
    // could in principle swap the session out from under us. Read through
    // an `any` view and feature-detect rather than hard-depend.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = handle.session as any;

    const isStreaming = handle.session.isStreaming === true;
    const isRetrying = session.isRetrying === true;
    const isCompacting = session.isCompacting === true;
    const isBashRunning = session.isBashRunning === true;

    const cancelled: InterruptTarget[] = [];
    let cleared: { steering: string[]; followUp: string[] } = {
      steering: [],
      followUp: [],
    };
    let settled = true;

    console.log(
      `[agent-manager] interrupt ${handle.config.name} (${id}): ` +
        `streaming=${isStreaming} retrying=${isRetrying} compacting=${isCompacting} bash=${isBashRunning}`,
    );

    // Compaction runs its own LLM call outside the agent turn, so it gets
    // its own cancel path (same as pi's TUI, which rebinds Escape to
    // abortCompaction for the duration).
    if (isCompacting && typeof session.abortCompaction === "function") {
      try {
        session.abortCompaction();
        cancelled.push("compaction");
      } catch (err) {
        console.warn(`[agent-manager] abortCompaction failed for ${id}: ${err}`);
      }
    }

    if (isStreaming || isRetrying) {
      // Drop the queue BEFORE aborting: pi flushes steering messages into
      // the next turn, and a user who just asked to stop doesn't want the
      // queue re-triggering one. Whatever we take out is handed back to
      // the caller so the UI can restore it into the composer.
      try {
        if (typeof session.clearQueue === "function") {
          const q = session.clearQueue() as { steering?: string[]; followUp?: string[] };
          cleared = {
            steering: [...(q?.steering ?? [])],
            followUp: [...(q?.followUp ?? [])],
          };
        }
      } catch (err) {
        console.warn(`[agent-manager] clearQueue failed for ${id}: ${err}`);
      }
      cancelled.push("turn");
      try {
        // `abort()` fires the AbortSignal (cancelling the in-flight LLM
        // call + any tool listening on it) and then awaits idle. Bound the
        // wait so one wedged tool can't hold the HTTP response open.
        await withTimeout(
          handle.session.abort(),
          INTERRUPT_ABORT_TIMEOUT_MS,
          `abort(${id})`,
        );
      } catch (err) {
        settled = false;
        console.warn(
          `[agent-manager] interrupt ${id}: abort did not settle: ${err instanceof Error ? err.message : err}`,
        );
      }
    } else if (isBashRunning && typeof session.abortBash === "function") {
      try {
        session.abortBash();
        cancelled.push("bash");
      } catch (err) {
        console.warn(`[agent-manager] abortBash failed for ${id}: ${err}`);
      }
    }

    // Belt and braces on the state machine. Aborting a turn makes pi emit
    // `agent_end`, which `handleAgentEvent` turns into waiting_input/idle.
    // If that didn't happen (abort raced an already-finishing turn, or an
    // event was dropped) we'd leave a live agent stuck showing "running"
    // in the sidebar, with the composer hiding the send-mode toggle.
    if (settled && handle.session.isStreaming !== true) {
      const current = this.stateManager.getAgent(id)?.state;
      if (current === "running") {
        const hasHistory = handle.session.messages.length > 0;
        this.setAgentState(id, hasHistory ? "waiting_input" : "idle");
      }
    }

    const interrupted = cancelled.length > 0;
    console.log(
      `[agent-manager] interrupt ${id}: ${
        interrupted ? `cancelled ${cancelled.join("+")}` : "nothing in flight"
      }` +
        (cleared.steering.length + cleared.followUp.length > 0
          ? ` (dropped ${cleared.steering.length + cleared.followUp.length} queued message(s))`
          : ""),
    );
    return { interrupted, cancelled, cleared, settled };
  }

  /** Stop an agent gracefully.
   *
   *  `finalState` distinguishes *why* the agent stopped:
   *    - "stopped" (default): user-initiated. Stays down across restarts.
   *    - "shutdown": server-initiated (see shutdown()). resumeAll()
   *      restarts these agents on the next startup. */
  async stopAgent(id: string, finalState: "stopped" | "shutdown" = "stopped"): Promise<void> {
    // Trigger pi's abort BEFORE taking the lock.
    //
    // sendMessage no longer holds the lock across `await session.prompt()`
    // (the long-lived prompt promise is awaited outside the lock so steer
    // calls can race in), so pre-lock abort is no longer strictly required
    // for deadlock avoidance. We still do it because:
    //   1. Fires the abort signal immediately rather than after acquiring
    //      the lock; cancellation feels snappier.
    //   2. Pi's session.abort() is explicitly designed to be safe to call
    //      concurrently with prompt() -- it fires the AbortSignal that
    //      prompt's LLM call is listening on, then awaits idle.
    const preLockHandle = this.handles.get(id);
    if (preLockHandle) {
      try {
        await preLockHandle.session.abort();
      } catch {
        // ignore abort errors — we're tearing down anyway
      }
    }
    return this.withAgentLock(id, async () => {
      // Re-fetch the handle: between abort and lock acquisition, another
      // op (e.g. a parallel removeAgent) may have already disposed it.
      const handle = this.handles.get(id);
      if (handle) {
        handle.unsubscribe();
        handle.session.dispose();
        this.handles.delete(id);
      }
      // Cancel any pending extension UI requests for this agent so the
      // SDK's canUseTool Promise unblocks (degrading to the cancel
      // sentinel) instead of hanging on a session that's gone.
      this.cancelAllUIRequestsForAgent(id, "agent stopped");
      // Widgets belong to the session that published them.
      this.clearWidgetsForAgent(id);
      this.setAgentState(id, finalState);
    });
  }

  /** Manually compact the running agent's session context. Wraps pi's
   *  `session.compact()`, which aborts the current operation first and
   *  then runs a summarisation pass. Errors if the agent isn't running.
   *
   *  `instructions` (optional) gets passed through to pi as custom
   *  guidance for the summary (e.g. "keep the architecture decisions,
   *  drop the debugging tangents").
   *
   *  No agent lock: compact() internally aborts any in-flight prompt and
   *  then runs its own LLM call. Taking pirouette's lock would deadlock
   *  for the same reason stopAgent() can't (sendMessage holds the lock
   *  across the streaming turn). pi's session is internally serialized,
   *  so concurrent compact + prompt is safe. */
  async compactAgent(id: string, instructions?: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) throw new Error(`Agent ${id} is not running`);
    console.log(
      `[agent-manager] compactAgent ${handle.config.name} (${id})${instructions ? ` with instructions` : ""}`,
    );
    // session.compact() emits compaction_start / compaction_end events
    // that already flow to clients via the existing event subscription.
    await handle.session.compact(instructions);
  }

  /** Discard the agent's current session and start a fresh one in the same
   *  worktree / branch / project. Old session files stay on disk (orphaned
   *  but available for forensic inspection); the next `SessionManager.
   *  continueRecent` call would still pick the new file because it has the
   *  later mtime.
   *
   *  Equivalent to pi's `/new` slash command. Aborts any in-flight turn,
   *  disposes the old session, and creates a new one. Idempotent on a
   *  stopped agent. */
  async newSession(id: string): Promise<void> {
    const config = this.stateManager.getAgent(id);
    if (!config) throw new Error(`Agent ${id} not found`);
    // Stop any running session (uses its own lock; we re-acquire below).
    await this.stopAgent(id);
    return this.withAgentLock(id, async () => {
      console.log(`[agent-manager] newSession for ${config.name} (${id})`);
      // resume:false makes startSession use SessionManager.create — a fresh
      // JSONL file with no history. The agent lands in `idle` because the
      // new session has zero messages.
      await this.startSession(config, { resume: false });
    });
  }

  /** Remove an agent entirely (stop + delete state, optionally delete disk). */
  async removeAgent(id: string, opts: DeleteAgentOptions = {}): Promise<void> {
    const config = this.stateManager.getAgent(id);
    // Stop first (uses its own lock).
    await this.stopAgent(id);
    // Then take the lock for state + disk cleanup.
    return this.withAgentLock(id, async () => {
      if (config) {
        const project = this.projectManager.getProject(config.projectName);
        // A handoff points the successor at the parent's worktree, so
        // "delete this agent and its worktree" must not pull the rug out
        // from under a sibling that is still working in it.
        const sharedWith = this.stateManager
          .getAgents()
          .filter((a) => a.id !== id && a.worktreePath === config.worktreePath);
        if (opts.deleteWorktree && config.worktreePath && sharedWith.length > 0) {
          console.log(
            `[agent-manager] keeping worktree ${config.worktreePath}: still used by ` +
              sharedWith.map((a) => `${a.name} (${a.id})`).join(", "),
          );
        } else if (opts.deleteWorktree && config.worktreePath) {
          try {
            if (project) {
              // Properly unregister the worktree with git so `worktree list`
              // doesn't leave stale entries. removeWorktree falls back to
              // rm -rf if the path isn't a registered worktree.
              await removeWorktree({
                repoPath: project.repoPath,
                worktreePath: config.worktreePath,
                branch: config.branchName,
                deleteBranch: true,
              });
            } else {
              await rm(config.worktreePath, { recursive: true, force: true });
            }
            console.log(`[agent-manager] removed worktree ${config.worktreePath}`);
          } catch (err) {
            console.error(
              `[agent-manager] failed to remove worktree ${config.worktreePath}: ${err}`,
            );
          }
        }
        if (opts.deleteSessions && config.sessionDir) {
          try {
            await rm(config.sessionDir, { recursive: true, force: true });
            console.log(`[agent-manager] removed session dir ${config.sessionDir}`);
          } catch (err) {
            console.error(
              `[agent-manager] failed to remove session dir ${config.sessionDir}: ${err}`,
            );
          }
        }
      }
      this.stateManager.removeAgent(id);
    });
  }

  /** Shut down all agents (for server shutdown). Persists state
   *  "shutdown" (not "stopped") so resumeAll() knows to bring these
   *  agents back on the next startup — a user-stopped agent is
   *  indistinguishable from a shutdown-stopped one otherwise.
   *
   *  Ordering matters for crash-safety. Under systemd (KillMode=mixed)
   *  we get a bounded window between SIGTERM and the SIGKILL sweep. So:
   *
   *    1. Mark every running agent "shutdown" and FLUSH immediately.
   *       Even if the graceful teardown below hangs and systemd SIGKILLs
   *       us mid-flight, the on-disk state already says "shutdown", so
   *       the next server's resumeAll() brings these agents back.
   *    2. THEN best-effort tear down each live pi session, bounded per
   *       agent so one stuck `session.abort()` can't wedge the whole
   *       shutdown (and blow past the unit's TimeoutStopSec).
   */
  async shutdown(): Promise<void> {
    const ids = [...this.handles.keys()];

    // 1. Persist intent first, then flush, so resume survives even a
    //    hard kill after this point. Capture whether each agent was
    //    actively mid-turn (`running`) so resumeAll() can auto-continue
    //    exactly those -- an agent that had finished and was waiting for
    //    the user must NOT be nudged.
    for (const id of ids) {
      const cfg = this.stateManager.getAgent(id);
      const handle = this.handles.get(id);
      // Two independent signals, because either can lag: the persisted
      // state machine (driven by agent_start/agent_end events) and pi's
      // own live streaming flag. If EITHER says mid-turn, we resume the
      // work on the next boot -- a spurious nudge is far cheaper than an
      // agent that silently drops what it was doing.
      const wasRunning =
        cfg?.state === "running" || handle?.session.isStreaming === true;
      this.stateManager.updateAgentState(id, {
        state: "shutdown",
        interruptedTurn: wasRunning,
      });
      if (handle) handle.config.state = "shutdown";
    }
    try {
      await this.stateManager.flush();
    } catch (err) {
      console.error(`[agent-manager] shutdown: initial state flush failed: ${err}`);
    }

    // 2. Graceful teardown, bounded per agent.
    for (const id of ids) {
      try {
        await withTimeout(
          this.stopAgent(id, "shutdown"),
          5000,
          `stopAgent(${id})`,
        );
      } catch (err) {
        console.error(
          `[agent-manager] shutdown: ${id} did not tear down cleanly: ${err}`,
        );
      }
    }
    try {
      await this.stateManager.flush();
    } catch (err) {
      console.error(`[agent-manager] shutdown: final state flush failed: ${err}`);
    }
  }

  // --- internal ---

  /** Bring up an agent's pi session. Caller can pass a pre-built
   *  `sessionManager` (used by `forkAgent` which produces one via
   *  `SessionManager.forkFrom`); otherwise we open the latest session
   *  (resume) or create a new one (resume=false). */
  private async startSession(
    config: AgentConfig,
    opts: { resume?: boolean; sessionManager?: SessionManager } = {},
  ): Promise<void> {
    const resume = opts.resume ?? false;
    // Defensive: always make sure the workdir and session dir exist.
    // They can get deleted out from under us if the user `rm -rf`s the data dir.
    await mkdir(config.worktreePath, { recursive: true });
    await mkdir(config.sessionDir, { recursive: true });

    // Set up per-worktree data-pipeline scaffolding (pivot / DVC) if the
    // source repo uses either. Idempotent: a no-op on every resume once
    // the symlinks are in place. Done here so it also retroactively fixes
    // pre-existing agents whose worktrees were created before this
    // feature shipped — their next startSession picks it up.
    const project = this.projectManager.getProject(config.projectName);
    if (project) {
      try {
        const setup = await setupWorktreeDataTools({
          repoPath: project.repoPath,
          worktreePath: config.worktreePath,
        });
        if (setup.pivot || setup.dvc) {
          const tools = [setup.pivot ? "pivot" : null, setup.dvc ? "dvc" : null]
            .filter(Boolean)
            .join(", ");
          console.log(
            `[agent-manager] data tools for ${config.name}: ${tools} (shared cache + config from ${project.repoPath})`,
          );
          if (setup.skipped.length > 0) {
            console.log(
              `[agent-manager] data-tools setup skipped (pre-existing non-symlink): ${setup.skipped.join(", ")}`,
            );
          }
        }
      } catch (err) {
        // Non-fatal: pivot/dvc failure shouldn't block agent startup. The
        // agent can still work, just without the shared-cache shortcut.
        console.error(
          `[agent-manager] data-tools setup failed for ${config.name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Make sure extensions are loaded so hawk/other custom providers are
    // registered in the model registry before we resolve a model.
    const resourceLoader = await this.ensureResourceLoader();

    // Compaction settings depend on the model's context window, so they are
    // applied below (once the model is resolved) via applyOverrides().
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 3 },
    });

    // Resolve the model strictly. We do NOT let the pi SDK fall back to
    // "first available model" because that can silently route through AWS
    // Bedrock (or another unintended provider) when the user has AWS SSO
    // credentials lying around. If the caller specified a model, it must
    // resolve; otherwise we use whatever is set in PIROUETTE_DEFAULT_MODEL.
    const envDefault = process.env.PIROUETTE_DEFAULT_MODEL;
    if (!config.model && !envDefault) {
      throw new Error(
        `No model specified. Pass --model to \`pru launch\`, or set ` +
          `PIROUETTE_DEFAULT_MODEL in the container environment (e.g. "anthropic/claude-sonnet-4-5").`,
      );
    }
    const requested = config.model ?? envDefault!;

    // Resolve against the registry *and* pre-flight the provider's
    // credentials. Both failures throw, which surfaces at `pru launch` /
    // the dashboard and parks the agent in `error` — see model-resolution.ts
    // for why an unauthenticated provider must not be allowed this far.
    const model = await resolveAgentModel(requested, {
      // Custom providers (e.g. `hawk`) often have `models: []` in
      // models.json, so `find()` misses them and the available list is
      // the only place they show up.
      find: (p, id) => this.modelRegistry.find(p, id),
      // The runtime's async getAvailable() refreshes the availability
      // snapshot; the synchronous registry facade only reads it.
      getAvailable: () => this.modelRuntime.getAvailable(),
      checkAuth: (m) => this.checkProviderAuth(m.provider),
    });

    // Persist the actual resolved model string so the UI can display what's
    // really being used (not just what was requested — which may have been
    // null/default).
    const resolvedModelString = `${model.provider}/${model.id}`;
    if (config.model !== resolvedModelString) {
      this.stateManager.updateAgentState(config.id, { model: resolvedModelString });
      config.model = resolvedModelString;
    }

    console.log(`[agent-manager] resolved model for ${config.name}: ${resolvedModelString}`);

    this.applyCompactionSettings(settingsManager, model, config.name);

    const thinkingLevel = (config.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high") ?? "off";

    const sessionManager =
      opts.sessionManager ??
      (resume
        ? SessionManager.continueRecent(config.worktreePath, config.sessionDir)
        : SessionManager.create(config.worktreePath, config.sessionDir));

    console.log(`[agent-manager] creating session for ${config.name}: cwd=${config.worktreePath} resume=${resume} model=${config.model ?? "default"}`);

    // Per-agent ResourceLoader wrapper.
    //
    // Pirouette uses ONE DefaultResourceLoader, instantiated with cwd =
    // dataDir (e.g. /data). That's fine for global things (extensions,
    // ~/.pi/agent/skills) but breaks anything that walks up from cwd —
    // most importantly AGENTS.md / CLAUDE.md, which pi expects to find in
    // the project tree. Without this wrapper, an agent working in
    // `/data/worktrees/<proj>/<agent>` would never see its project's
    // AGENTS.md because the shared loader's `getAgentsFiles()` scanned
    // from /data.
    //
    // We delegate everything to the shared loader except
    // `getAgentsFiles()`, which we recompute on every call against the
    // agent's actual worktreePath. `loadProjectContextFiles` is pi's own
    // helper — same one DefaultResourceLoader uses internally, so the
    // behaviour is identical to what pi's TUI does when launched with
    // cwd=worktreePath.
    //
    // (Project-local skills / extensions / prompt-templates discovered
    // via `.pi/skills` in the worktree are NOT included here because the
    // user's skills currently live in ~/.pi/agent/skills/ which already
    // works. If we ever need per-worktree skills too, switch to a fully
    // per-agent DefaultResourceLoader — just be mindful that re-scanning
    // extensions on every agent boot would redo provider registration.)
    const agentDir = getAgentDir();
    const agentResourceLoader: ResourceLoader = {
      getExtensions: () => resourceLoader.getExtensions(),
      getSkills: () => resourceLoader.getSkills(),
      getPrompts: () => resourceLoader.getPrompts(),
      getThemes: () => resourceLoader.getThemes(),
      getAgentsFiles: () => ({
        agentsFiles: loadProjectContextFiles({ cwd: config.worktreePath, agentDir }),
      }),
      getSystemPrompt: () => resourceLoader.getSystemPrompt(),
      // Tell the agent about the bash deadline up front. Without this it
      // only learns the rule by having a command killed, and the tool
      // description still advertises "no default timeout".
      getAppendSystemPrompt: () => {
        const base = resourceLoader.getAppendSystemPrompt();
        const guidance = bashTimeoutGuidance(this.getBashTimeoutPolicy());
        return guidance ? [...base, guidance] : base;
      },
      extendResources: (paths) => resourceLoader.extendResources(paths),
      reload: () => resourceLoader.reload(),
    };
    const ctxFiles = agentResourceLoader.getAgentsFiles().agentsFiles;
    console.log(
      `[agent-manager] context files for ${config.name}: ${ctxFiles.length}` +
        (ctxFiles.length > 0 ? ` (${ctxFiles.map((f: { path: string }) => f.path).join(", ")})` : ""),
    );

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: config.worktreePath,
      sessionManager,
      settingsManager,
      modelRuntime: this.modelRuntime,
      resourceLoader: agentResourceLoader,
      model,
      thinkingLevel,
    });

    // Plug in pirouette's ExtensionUIContext so extensions that call
    // ctx.ui.select / .confirm / .input (notably pi-cas-provider's
    // AskUserQuestion bridge) reach the browser via WS instead of
    // hitting the SDK's noOpUIContext and bailing as "no-ui-available".
    // bindExtensions is safe to call after createAgentSession — it
    // (re)assigns the runner's UI slot and re-emits session_start to
    // extensions. See dist/core/agent-session.js:1610 bindExtensions.
    try {
      await session.bindExtensions({
        uiContext: createPirouetteUIContext(config.id, this.uiContextHostFor(config.id)),
      });
    } catch (err) {
      // Non-fatal: bindExtensions failing means UI primitives stay no-op,
      // which matches the pre-fix behavior. Log so we can debug.
      console.error(
        `[agent-manager] bindExtensions failed for ${config.name}: ${err instanceof Error ? err.message : err}`,
      );
    }

    console.log(`[agent-manager] session created for ${config.name}: file=${session.sessionFile ?? "(none)"} model=${session.model?.id ?? "unknown"}`);
    if (modelFallbackMessage) {
      console.log(`[agent-manager] ${config.name}: ${modelFallbackMessage}`);
    }

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.handleAgentEvent(config.id, event);
    });

    this.handles.set(config.id, { config, session, unsubscribe, settingsManager });
    // Fresh sessions are "idle" (no messages yet). Resumed sessions with
    // existing history are already in a user-turn, so they're "waiting_input".
    const hasHistory = session.messages.length > 0;
    this.setAgentState(config.id, resume && hasHistory ? "waiting_input" : "idle");
  }

  /** Effective bash-timeout policy, resolved once per server process. */
  private getBashTimeoutPolicy(): BashTimeoutPolicy {
    if (!this.bashTimeoutPolicy) {
      let configured;
      try {
        configured = getConfig().defaults?.bash_timeout;
      } catch (err) {
        console.error(`[agent-manager] could not read bash_timeout config: ${err}`);
      }
      const { policy, warnings } = resolveBashTimeoutPolicy(configured);
      for (const w of warnings) console.warn(`[agent-manager] bash timeout config: ${w}`);
      console.log(
        isInertBashTimeoutPolicy(policy)
          ? `[agent-manager] bash timeouts disabled (pi's unbounded default)`
          : `[agent-manager] bash timeout: ${policy.defaultSeconds || "none"}s by default, ` +
              `${policy.maxSeconds > 0 ? `${policy.maxSeconds}s` : "no"} cap on explicit timeouts`,
      );
      this.bashTimeoutPolicy = policy;
    }
    return this.bashTimeoutPolicy;
  }

  /** Is `provider` usable for a turn right now?
   *
   *  Deliberately the same question pi's `AgentSession.prompt()` asks
   *  before it starts a turn (configured auth, or a credential that
   *  resolves on demand) — a model that fails here is one whose first
   *  prompt would throw "No API key found". Asking it at session start
   *  turns that into a launch-time error. */
  private async checkProviderAuth(
    provider: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      if (this.modelRuntime.hasConfiguredAuth(provider)) return { ok: true };
      if ((await this.modelRuntime.checkAuth(provider)) !== undefined) return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `auth check for provider "${provider}" failed: ${msg}` };
    }
    return {
      ok: false,
      error: this.modelRuntime.isUsingOAuth(provider)
        ? `credentials for provider "${provider}" have expired — log in again on the host`
        : `no API key for provider "${provider}" on this host`,
    };
  }

  /** Effective auto-compaction policy, resolved once per server process. */
  private getCompactionPolicy(): CompactionPolicy {
    if (!this.compactionPolicy) {
      let configured;
      try {
        configured = getConfig().defaults?.compaction;
      } catch (err) {
        console.error(`[agent-manager] could not read compaction config: ${err}`);
      }
      const { policy, warnings } = resolveCompactionPolicy(configured);
      for (const w of warnings) console.warn(`[agent-manager] compaction config: ${w}`);
      if (policy.fraction > 0) {
        console.log(
          `[agent-manager] auto-compaction at ${Math.round(policy.fraction * 100)}% of the ` +
            `context window for ${policy.models.length > 0 ? policy.models.join(", ") : "every model"}`,
        );
      }
      this.compactionPolicy = policy;
    }
    return this.compactionPolicy;
  }

  /** Push model-dependent compaction settings into a session's settings
   *  manager. Called at session start and again whenever the model changes,
   *  because the trigger point is a fraction of *that model's* context
   *  window — switching from a 1M-token model to a 200k one without
   *  recomputing would leave the agent with a reserve larger than the whole
   *  window (i.e. compacting on every single turn). */
  private applyCompactionSettings(
    settingsManager: SettingsManager,
    model: { provider?: string; id?: string; contextWindow?: number } | null | undefined,
    agentName: string,
  ): void {
    const settings = compactionSettingsFor(this.getCompactionPolicy(), model);
    applyCompactionSettings(settingsManager, settings);
    if (settings.triggerTokens !== null) {
      console.log(
        `[agent-manager] ${agentName}: auto-compact at ~${settings.triggerTokens} tokens ` +
          `(keeping the most recent ${settings.keepRecentTokens})`,
      );
    }
  }

  /** Transition an agent into an error state with a human-readable message. */
  private markError(config: AgentConfig, message: string): void {
    console.error(`[agent-manager] ${config.name} error: ${message}`);
    this.stateManager.updateAgentState(config.id, { errorMessage: message });
    config.errorMessage = message;
    this.setAgentState(config.id, "error");
  }

  private handleAgentEvent(agentId: string, event: AgentSessionEvent): void {
    const normalized = normalizeEvent(event);
    console.log(`[agent-manager] event from ${agentId}: ${event.type}`);
    this.emitEvent(agentId, normalized);

    // Track state transitions based on events
    if (event.type === "agent_start") {
      this.setAgentState(agentId, "running");
    } else if (event.type === "agent_end") {
      // The agent finished processing a turn. If there's any conversation
      // history, the ball is now in the user's court — use `waiting_input`
      // instead of the more neutral `idle`. This gives the UI a signal it
      // can use for "this agent wants your attention" indicators.
      const handle = this.handles.get(agentId);
      const hasHistory = (handle?.session.messages.length ?? 0) > 0;
      this.setAgentState(agentId, hasHistory ? "waiting_input" : "idle");
    }

    // Accumulate usage from completed assistant turns.
    if (event.type === "turn_end" || event.type === "message_end") {
      const msg = (event as { message?: unknown }).message as
        | {
            role?: string;
            usage?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              totalTokens?: number;
              cost?: { total?: number };
            };
          }
        | undefined;
      // Only count assistant messages, and only on message_end to avoid
      // double-counting (turn_end also emits the same message).
      if (event.type === "message_end" && msg?.role === "assistant" && msg.usage) {
        this.accumulateUsage(agentId, msg.usage);
      }
    }

    // Update lastActivity
    this.stateManager.updateAgentState(agentId, {
      lastActivity: new Date().toISOString(),
    });
  }

  private accumulateUsage(
    agentId: string,
    usage: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: { total?: number };
    },
  ): void {
    const config = this.stateManager.getAgent(agentId);
    if (!config) return;
    const u = config.usage ?? emptyUsage();
    u.inputTokens += usage.input ?? 0;
    u.outputTokens += usage.output ?? 0;
    u.cacheReadTokens += usage.cacheRead ?? 0;
    u.cacheWriteTokens += usage.cacheWrite ?? 0;
    u.totalTokens +=
      usage.totalTokens ??
      (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    u.costUsd += usage.cost?.total ?? 0;
    u.turns += 1;
    this.stateManager.updateAgentState(agentId, { usage: u });
    const handle = this.handles.get(agentId);
    if (handle) handle.config.usage = u;
  }

  private setAgentState(id: string, state: AgentState): void {
    this.stateManager.updateAgentState(id, { state });
    const handle = this.handles.get(id);
    if (handle) handle.config.state = state;
    this.emitStateChange(id, state);
  }
}
