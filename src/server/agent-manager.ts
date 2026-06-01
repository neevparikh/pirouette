/** Manages pi SDK agent sessions — create, resume, stop, send messages. */

import { mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AuthStorage,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  loadProjectContextFiles,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type EventBusController,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";


import { createWorktree, removeWorktree } from "./git.js";
import { setupWorktreeDataTools } from "./worktree-setup.js";
import { ProjectManager } from "./project-manager.js";
import { StateManager } from "./state.js";
import { normalizeEvent } from "./normalize.js";
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
  type ChatImage,
  type ChatMessage,
  type DeleteAgentOptions,
  type ExtensionUIRequest,
  type FastModeState,
  type NormalizedEvent,
  type WsEnvelope,
} from "./types.js";

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

  private authStorage: ReturnType<typeof AuthStorage.create>;
  private modelRegistry: ReturnType<typeof ModelRegistry.create>;
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
  /** Latest global fast-mode badge state (null until a fast-mode-capable
   *  provider reports in). Mirrored to clients via the `fast_mode`
   *  WS envelope and primed on connect via getFastMode(). */
  private fastMode: FastModeState | null = null;

  constructor(
    private readonly stateManager: StateManager,
    private readonly projectManager: ProjectManager,
    private readonly dataDir: string,
  ) {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

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
        const loader = new DefaultResourceLoader({
          cwd: this.dataDir,
          agentDir: getAgentDir(),
          eventBus,
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.modelRegistry as any).registerProvider(name, config);
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

        // Summary: providers available for lookup
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const avail = await (this.modelRegistry as any).getAvailable();
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
    };
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

  /** Current global fast-mode badge state, or null if no fast-mode-capable
   *  provider has reported in. Used to prime newly-connected WS clients. */
  getFastMode(): FastModeState | null {
    return this.fastMode;
  }

  /** Handle a `pi:fast-mode` event from the shared extension bus
   *  (pi-cas-provider). Normalizes the payload, stores it as the global
   *  badge state, and broadcasts it to all dashboard clients. Defensive
   *  about the payload shape since it crosses an extension boundary that
   *  pirouette doesn't control. */
  private handleFastModeEvent(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const d = data as { intent?: unknown; actual?: unknown; model?: unknown };
    const actual =
      d.actual === "on" || d.actual === "off" || d.actual === "cooldown"
        ? d.actual
        : undefined;
    const next: FastModeState = {
      intent: Boolean(d.intent),
      ...(actual ? { actual } : {}),
      ...(typeof d.model === "string" ? { model: d.model } : {}),
    };
    this.fastMode = next;
    console.log(
      `[agent-manager] fast-mode update: intent=${next.intent} actual=${next.actual ?? "?"} model=${next.model ?? "?"}`,
    );
    this.broadcastWs({ kind: "fast_mode", state: next });
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reg = this.modelRegistry as any;
    try {
      const models = (await reg.getAvailable()) as Array<{
        provider: string;
        id: string;
        contextWindow?: number;
        reasoning?: boolean;
      }>;
      return models
        .map((m) => ({
          qualifiedId: `${m.provider}/${m.id}`,
          provider: m.provider,
          id: m.id,
          contextWindow: m.contextWindow ?? 0,
          reasoning: !!m.reasoning,
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const available = await (this.modelRegistry as any).getAvailable();
        model = available.find(
          (m: { provider: string; id: string }) => m.provider === provider && m.id === modelId,
        );
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

  /** Resume all agents that were previously running. */
  async resumeAll(): Promise<void> {
    // Ensure extensions are loaded up-front so the model registry is populated.
    await this.ensureResourceLoader();
    const agents = this.stateManager.getAgents();
    for (const config of agents) {
      if (config.state === "stopped") continue;
      try {
        await this.resumeAgent(config.id);
      } catch (err) {
        console.error(`[agent-manager] failed to resume agent ${config.name}: ${err}`);
        this.stateManager.updateAgentState(config.id, { state: "error" });
      }
    }
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
        throw err;
      }
    } else {
      console.log(`[agent-manager] ${mode} enqueued for ${id}`);
    }
  }

  /** Stop an agent gracefully. */
  async stopAgent(id: string): Promise<void> {
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
      this.setAgentState(id, "stopped");
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
        if (opts.deleteWorktree && config.worktreePath) {
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

  /** Shut down all agents (for server shutdown). */
  async shutdown(): Promise<void> {
    const ids = [...this.handles.keys()];
    for (const id of ids) {
      await this.stopAgent(id);
    }
    await this.stateManager.flush();
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
    const [provider, modelId] = requested.includes("/")
      ? (requested.split("/", 2) as [string, string])
      : ["anthropic", requested];

    let model = this.modelRegistry.find(provider, modelId) ?? undefined;

    // Custom providers (e.g. `hawk`) often have `models: []` in models.json,
    // so `find()` returns undefined. Build a minimal model record manually
    // so we can still route through them. The pi SDK does this internally
    // via buildFallbackModel; we replicate a simpler version here.
    if (!model) {
      const available = await this.modelRegistry.getAvailable();
      model = available.find((m) => m.provider === provider && m.id === modelId);
    }

    if (!model) {
      throw new Error(
        `Model "${requested}" not found. Check ~/.pi/agent/models.json and /login for available providers. " +
          "Available: ${(await this.modelRegistry.getAvailable()).map((m) => `${m.provider}/${m.id}`).slice(0, 8).join(", ")}...`,
      );
    }

    // Persist the actual resolved model string so the UI can display what's
    // really being used (not just what was requested — which may have been
    // null/default).
    const resolvedModelString = `${model.provider}/${model.id}`;
    if (config.model !== resolvedModelString) {
      this.stateManager.updateAgentState(config.id, { model: resolvedModelString });
      config.model = resolvedModelString;
    }

    console.log(`[agent-manager] resolved model for ${config.name}: ${resolvedModelString}`);

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
      getAppendSystemPrompt: () => resourceLoader.getAppendSystemPrompt(),
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
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
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

    this.handles.set(config.id, { config, session, unsubscribe });
    // Fresh sessions are "idle" (no messages yet). Resumed sessions with
    // existing history are already in a user-turn, so they're "waiting_input".
    const hasHistory = session.messages.length > 0;
    this.setAgentState(config.id, resume && hasHistory ? "waiting_input" : "idle");
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
