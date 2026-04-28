/** Manages pi SDK agent sessions — create, resume, stop, send messages. */

import { mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";


import { createWorktree, removeWorktree } from "./git.js";
import { ProjectManager } from "./project-manager.js";
import { StateManager } from "./state.js";
import { normalizeEvent } from "./normalize.js";
import {
  DEFAULT_PROJECT_NAME,
  emptyUsage,
  type AgentConfig,
  type AgentState,
  type ChatMessage,
  type DeleteAgentOptions,
  type NormalizedEvent,
} from "./types.js";

export interface AgentHandle {
  config: AgentConfig;
  session: AgentSession;
  unsubscribe: () => void;
}

export type AgentEventCallback = (agentId: string, event: NormalizedEvent) => void;
export type AgentStateCallback = (agentId: string, state: AgentState) => void;

export class AgentManager {
  private handles = new Map<string, AgentHandle>();
  private eventListeners: AgentEventCallback[] = [];
  private stateListeners: AgentStateCallback[] = [];

  /** Per-agent operation queue. Every create/resume/stop/send/remove for a
   *  given agent runs through `withAgentLock(id, ...)` to prevent races
   *  (e.g. sendMessage arriving mid-resume, double-stop, etc). */
  private agentLocks = new Map<string, Promise<unknown>>();

  private authStorage: ReturnType<typeof AuthStorage.create>;
  private modelRegistry: ReturnType<typeof ModelRegistry.create>;
  /** Shared ResourceLoader. We load it once at init so extensions (like
   *  pi-hawk-provider) register their providers + models in the modelRegistry
   *  before any agent session is created. Every session reuses this loader.
   */
  private resourceLoader: DefaultResourceLoader | null = null;
  private resourceLoaderInit: Promise<void> | null = null;

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
        const loader = new DefaultResourceLoader({
          cwd: this.dataDir,
          agentDir: getAgentDir(),
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

  private emitEvent(agentId: string, event: NormalizedEvent): void {
    for (const cb of this.eventListeners) cb(agentId, event);
  }

  private emitStateChange(agentId: string, state: AgentState): void {
    for (const cb of this.stateListeners) cb(agentId, state);
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

  isRunning(id: string): boolean {
    return this.handles.has(id);
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

  getMessages(id: string): ChatMessage[] {
    const handle = this.handles.get(id);
    if (!handle) return [];

    const messages = handle.session.messages;
    console.log(`[agent-manager] getMessages for ${id}: ${messages.length} raw messages`);
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : (msg.content as Array<{ type: string; text?: string }>)
                .filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("");
        result.push({ role: "user", content, ts: msg.timestamp });
      } else if (msg.role === "assistant") {
        // Extract thinking, text, and tool-calls separately so the UI can
        // render them as their own timeline entries.
        const thinkingParts: string[] = [];
        const textParts: string[] = [];
        for (const block of msg.content) {
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
        result.push({
          role: "tool_result",
          content: truncated || (msg.isError ? "✗ error" : "✓ done"),
          toolName: msg.toolName,
          toolCallId: msg.toolCallId,
          isError: msg.isError,
          ts: msg.timestamp,
        });
      } else if (msg.role === "compactionSummary") {
        result.push({
          role: "system",
          content: "[context compacted]",
          ts: (msg as { timestamp: number }).timestamp,
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
    opts: { mode?: "steer" | "followUp" } = {},
  ): Promise<void> {
    return this.withAgentLock(id, async () => {
      const handle = this.handles.get(id);
      if (!handle) throw new Error(`Agent ${id} is not running`);

      const mode = opts.mode ?? "steer";
      console.log(
        `[agent-manager] sendMessage to ${handle.config.name} (${id}): streaming=${handle.session.isStreaming} mode=${mode}`,
      );
      // Clear any prior error when the user sends a new message.
      if (handle.config.errorMessage) {
        this.stateManager.updateAgentState(id, { errorMessage: null });
        handle.config.errorMessage = null;
      }
      this.setAgentState(id, "running");

      if (handle.session.isStreaming) {
        if (mode === "followUp") {
          console.log(`[agent-manager] using followUp (agent is streaming)`);
          await handle.session.followUp(message);
        } else {
          console.log(`[agent-manager] using steer (agent is streaming)`);
          await handle.session.steer(message);
        }
      } else {
        console.log(`[agent-manager] using prompt (agent is idle)`);
        await handle.session.prompt(message);
      }
      console.log(`[agent-manager] prompt/${mode} resolved for ${id}`);
    });
  }

  /** Stop an agent gracefully. */
  async stopAgent(id: string): Promise<void> {
    return this.withAgentLock(id, async () => {
      const handle = this.handles.get(id);
      if (handle) {
        try {
          await handle.session.abort();
        } catch {
          // ignore abort errors
        }
        handle.unsubscribe();
        handle.session.dispose();
        this.handles.delete(id);
      }
      this.setAgentState(id, "stopped");
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

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: config.worktreePath,
      sessionManager,
      settingsManager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      resourceLoader,
      model,
      thinkingLevel,
    });

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
