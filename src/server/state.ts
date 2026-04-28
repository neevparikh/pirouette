/** Persistent state management — reads/writes pirouette metadata to disk. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PirouetteState;
      // Migrate each agent record so fields added later (like `usage`) are
      // populated with sensible defaults.
      const agents: Record<string, AgentConfig> = {};
      for (const [id, a] of Object.entries(parsed.agents ?? {})) {
        agents[id] = migrateAgent(a as Partial<AgentConfig> & { id: string; name: string });
      }
      this.state = { agents, projects: parsed.projects ?? {} };
    } catch {
      this.state = { agents: {}, projects: {} };
    }
  }

  async save(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2));
    this.dirty = false;
  }

  private scheduleSave(): void {
    if (this.flushTimer) return;
    this.dirty = true;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = undefined;
      if (this.dirty) await this.save();
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
