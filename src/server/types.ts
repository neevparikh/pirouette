/** Persistent agent state. Every agent belongs to exactly one project. */
export interface AgentConfig {
  id: string;
  name: string;
  /** Name of the owning Project (required). Defaults to "scratchpad" when the
   *  user hasn't explicitly picked one. */
  projectName: string;
  /** Absolute path to the agent's working directory. For an agent in a
   *  project with a repo, this is a git worktree on branch `agent/<slug>`.
   *  For the scratchpad / bare project, this is a plain directory. */
  worktreePath: string;
  /** Git branch the worktree is checked out on, or null for bare projects
   *  with no git repo yet. */
  branchName: string | null;
  /** Absolute path to the agent's session directory (pi JSONL session files). */
  sessionDir: string;
  state: AgentState;
  createdAt: string;
  lastActivity: string;
  model: string | null;
  thinkingLevel: string;
  /** Accumulated usage across all turns. */
  usage: AgentUsage;
  /** Last fatal error message if state is "error"; null otherwise. */
  errorMessage?: string | null;
  /** Agent ID this one was forked from, if any. Used for tree visualization
   *  so the sidebar can show fork relationships (`agentA → forked-from-agentB`).
   *  Null for top-level agents created via `pru launch` or @-mention. */
  parentAgentId?: string | null;
}

export interface AgentUsage {
  /** Total cost in USD. */
  costUsd: number;
  /** Total tokens (input + output + cache read + cache write). */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Number of assistant turns completed. */
  turns: number;
}

export function emptyUsage(): AgentUsage {
  return {
    costUsd: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
  };
}

export type AgentState =
  /** Setting up the session (initial start, not yet ready for input). */
  | "starting"
  /** Currently cloning a git repo into the workdir. */
  | "cloning"
  /** Agent is actively processing a prompt. */
  | "running"
  /** Session is ready but no user prompts have been sent yet. */
  | "idle"
  /** Agent finished its last turn and is waiting for the user to reply. */
  | "waiting_input"
  /** Agent was manually stopped. */
  | "stopped"
  /** Fatal error during startup or in-flight (see `errorMessage`). */
  | "error";

/** Top-level pirouette state persisted to disk. */
export interface PirouetteState {
  agents: Record<string, AgentConfig>;
  projects: Record<string, ProjectConfig>;
}

/** A project groups 0..N agents that share a filesystem location (repo).
 *  The scratchpad project exists by default for agents that don't need
 *  a dedicated repo context. */
export interface ProjectConfig {
  /** Unique, filesystem-safe name. Used as an id throughout the API. */
  name: string;
  /** Optional HTTPS/SSH git remote. If set, the repo is cloned on project
   *  creation. If null, the project has a bare workspace (no git) that can
   *  be `git init`'d later by an agent. */
  repoUrl: string | null;
  /** Absolute path to the project's main repo/dir on disk. */
  repoPath: string;
  /** Where this project's per-agent worktrees live. Typically a sibling of
   *  repoPath so pip/npm/pytest don't scan agent branches by mistake. */
  worktreesDir: string;
  /** Default branch of the repo (for worktree base ref). Null if no repo. */
  defaultBranch: string | null;
  createdAt: string;
}

/** Name of the auto-created project used when the user doesn't specify one. */
export const DEFAULT_PROJECT_NAME = "scratchpad";

/** Envelope sent over WebSocket to clients. */
export type WsEnvelope =
  | { kind: "agent_event"; agentId: string; event: NormalizedEvent }
  | { kind: "agent_state_change"; agentId: string; state: AgentState }
  | { kind: "agents_list"; agents: AgentConfig[] }
  | { kind: "agent_created"; agent: AgentConfig }
  | { kind: "agent_removed"; agentId: string }
  | { kind: "projects_list"; projects: ProjectConfig[] }
  | { kind: "project_created"; project: ProjectConfig }
  | { kind: "project_removed"; projectName: string }
  | { kind: "error"; message: string };

export interface NormalizedEvent {
  type: string;
  [key: string]: unknown;
}

/** Request body for POST /api/agents. */
export interface CreateAgentRequest {
  name: string;
  /** Which project this agent belongs to. Defaults to `scratchpad`. */
  projectName?: string;
  model?: string;
  thinkingLevel?: string;
}

/** Request body for POST /api/projects. */
export interface CreateProjectRequest {
  name: string;
  repoUrl?: string;
}

/** Request body for DELETE /api/agents/:id. */
export interface DeleteAgentOptions {
  /** If true, also delete the worktree directory on disk. Default false. */
  deleteWorktree?: boolean;
  /** If true, also delete session files on disk. Default false. */
  deleteSessions?: boolean;
}

/** Request body for DELETE /api/projects/:name. */
export interface DeleteProjectOptions {
  /** If true, also rm -rf the project's repo + worktrees. Default false. */
  deleteRepo?: boolean;
  /** If true, the request fails if the project has active agents. Default true. */
  requireEmpty?: boolean;
}

/** Request body for POST /api/agents/:id/message. */
export interface SendMessageRequest {
  message: string;
  /** How to deliver this message when the agent is currently streaming.
   *  Ignored if the agent is idle (a new turn always starts via `prompt`).
   *    - `"steer"` (default) — interrupt the current turn, deliver as
   *      a new user prompt. Matches pi's TUI default.
   *    - `"followUp"` — queue, deliver after the current turn ends.
   *  Both produce `queue_update` events while the queue is non-empty. */
  mode?: "steer" | "followUp";
}

/** A chat message formatted for the frontend. */
export interface ChatMessage {
  role: "user" | "assistant" | "thinking" | "tool" | "tool_result" | "system";
  content: string;
  ts: number;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
}
