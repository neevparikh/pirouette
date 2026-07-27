/** Persistent state management — reads/writes pirouette metadata to disk.
 *
 *  Crash-consistency model:
 *    - `save()` writes to `<file>.tmp` and then `rename()`s into place. On
 *      POSIX, rename is atomic for paths on the same filesystem; readers
 *      see either the previous file or the new one, never a half-written
 *      file. (Both files live in `stateDir`, so this property holds.)
 *    - `load()` distinguishes "file doesn't exist" (legitimate first run
 *      — use empty state) from any other error (parse failure, EACCES,
 *      I/O error, etc.). On parse / read failures the file is renamed to
 *      `pirouette-state.json.broken-<ts>` so the next save creates a
 *      fresh file BUT the old data is preserved on disk for forensics.
 *      We log loudly and re-throw — the server refuses to start with
 *      ambiguous state rather than silently wiping it.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_PROJECT_NAME,
  emptyUsage,
  type AgentConfig,
  type PirouetteState,
  type ProjectConfig,
} from "./types.js";

/** Fill in fields added after an agent was persisted. Idempotent and safe to
 *  call on already-migrated records.
 *
 *  Migration rules:
 *    - agents without a `projectName` get assigned to DEFAULT_PROJECT_NAME
 *    - the stale `repoUrl` field (pre-phase-2) is dropped
 *    - `branchName` defaults to null (unknown for old agents)
 *    - `parentAgentId` defaults to null (top-level agent) for records
 *      saved before forking existed
 *    - `archived` defaults to false for records saved before archiving
 *      existed
 */
function migrateAgent(
  agent: Partial<AgentConfig> & { id: string; name: string; projectName?: string | null },
): AgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    projectName: agent.projectName || DEFAULT_PROJECT_NAME,
    worktreePath: agent.worktreePath ?? "",
    branchName: agent.branchName ?? null,
    sessionDir: agent.sessionDir ?? "",
    state: agent.state ?? "stopped",
    createdAt: agent.createdAt ?? new Date().toISOString(),
    lastActivity: agent.lastActivity ?? new Date().toISOString(),
    model: agent.model ?? null,
    thinkingLevel: agent.thinkingLevel ?? "off",
    usage: agent.usage ?? emptyUsage(),
    errorMessage: agent.errorMessage ?? null,
    parentAgentId: agent.parentAgentId ?? null,
    // Whether the user has archived this agent. Archived agents are
    // hidden from the default dashboard listing but not deleted.
    archived: agent.archived ?? false,
  };
}

const EMPTY_STATE: PirouetteState = { agents: {}, projects: {} };

export class StateManager {
  private state: PirouetteState = { ...EMPTY_STATE, agents: {}, projects: {} };
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly stateDir: string) {}

  get filePath(): string {
    return path.join(this.stateDir, "pirouette-state.json");
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Legitimate first-run case: no state file yet.
        this.state = { agents: {}, projects: {} };
        return;
      }
      // Any other read error (EACCES, EIO, EISDIR, …) is suspicious.
      // Don't silently wipe; bubble up so the server fails to start
      // and the operator can investigate.
      console.error(
        `[state] failed to read ${this.filePath}: ${(err as Error).message}`,
      );
      throw err;
    }

    let parsed: PirouetteState;
    try {
      parsed = JSON.parse(raw) as PirouetteState;
    } catch (err) {
      // Half-written file from a crash mid-save (e.g. SIGHUP from
      // `tmux kill-session` while writeFile was streaming). Quarantine
      // it so the next save creates a fresh file but the bad bytes are
      // preserved on disk for forensics, then refuse to start — better
      // than silently dropping all agents and projects.
      const broken = `${this.filePath}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        await rename(this.filePath, broken);
        console.error(`[state] state file is not valid JSON; quarantined to ${broken}`);
      } catch (renameErr) {
        console.error(
          `[state] state file is not valid JSON and could not be quarantined: ${(renameErr as Error).message}`,
        );
      }
      throw new Error(
        `state file ${this.filePath} is corrupted: ${(err as Error).message}. ` +
          `Quarantined copy preserved at ${broken}. Inspect it, or remove it to start fresh.`,
      );
    }

    // Migrate each agent record so fields added later (like `usage`) are
    // populated with sensible defaults.
    const agents: Record<string, AgentConfig> = {};
    for (const [id, a] of Object.entries(parsed.agents ?? {})) {
      agents[id] = migrateAgent(a as Partial<AgentConfig> & { id: string; name: string });
    }
    this.state = { agents, projects: parsed.projects ?? {} };
  }

  /** Serialize saves. Two overlapping `save()` calls used to race on the
   *  shared `<file>.tmp` path: both write it, the first rename wins, the
   *  second gets ENOENT. From the debounced timer that surfaced as an
   *  *unhandled rejection*, which on modern Node takes the whole server
   *  down (and with it every agent). Chaining is enough — writes are
   *  cheap and always dump the latest in-memory state. */
  private saveChain: Promise<void> = Promise.resolve();

  async save(): Promise<void> {
    const next = this.saveChain.then(
      () => this.writeStateFile(),
      () => this.writeStateFile(),
    );
    // Keep the chain alive even if this write fails; the caller still sees
    // the rejection via `next`.
    this.saveChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async writeStateFile(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    // Atomic write: stream to a tmp file (same dir = same filesystem =
    // rename is atomic on POSIX), then rename into place. A reader sees
    // either the prior version or the full new version — never a
    // partially-written file. Crash-safe against SIGHUP, OOM, container
    // restart, host reboot, etc.
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.filePath);
    this.dirty = false;
  }

  private scheduleSave(): void {
    if (this.flushTimer) return;
    this.dirty = true;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (!this.dirty) return;
      // Never let a background save reject into the void: an unhandled
      // rejection here would kill the server process.
      void this.save().catch((err) => {
        console.error(`[state] background save failed: ${err}`);
      });
    }, 1000);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirty) await this.save();
  }

  // --- agents ---

  getAgents(): AgentConfig[] {
    return Object.values(this.state.agents);
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.state.agents[id];
  }

  putAgent(agent: AgentConfig): void {
    this.state.agents[agent.id] = agent;
    this.scheduleSave();
  }

  removeAgent(id: string): void {
    delete this.state.agents[id];
    this.scheduleSave();
  }

  updateAgentState(id: string, partial: Partial<AgentConfig>): void {
    const existing = this.state.agents[id];
    if (!existing) return;
    Object.assign(existing, partial);
    this.scheduleSave();
  }

  // --- projects ---

  getProjects(): ProjectConfig[] {
    return Object.values(this.state.projects);
  }

  getProject(name: string): ProjectConfig | undefined {
    return this.state.projects[name];
  }

  putProject(project: ProjectConfig): void {
    this.state.projects[project.name] = project;
    this.scheduleSave();
  }

  removeProject(name: string): void {
    delete this.state.projects[name];
    this.scheduleSave();
  }
}
