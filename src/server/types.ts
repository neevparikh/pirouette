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
  /** Whether the user has archived this agent. Archived agents remain
   *  fully functional and on disk; the dashboard hides them from the
   *  default sidebar listing unless "show archived" is toggled on. */
  archived?: boolean;
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
  /** Agent was manually stopped by the user. Stays down across server
   *  restarts until explicitly resumed. */
  | "stopped"
  /** Agent was stopped by a graceful server shutdown, NOT by the user.
   *  resumeAll() restarts agents in this state on the next server startup
   *  (unlike "stopped", which stays down). */
  | "shutdown"
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

/** Global fast-mode badge state, mirrored from pi-cas-provider's
 *  `pi:fast-mode` event bus channel (see pi-cas-provider/src/badge.ts).
 *  Fast mode is a provider-wide setting in pirouette (one shared
 *  ResourceLoader / provider instance across all agents), so this is a
 *  single global state rather than per-agent.
 *
 *    - `intent`  : what the provider will request on the next turn.
 *    - `actual`  : what the API actually engaged on the most recent turn.
 *    - `model`   : model id from the most recent completed turn.
 */
export interface FastModeState {
  intent: boolean;
  actual?: "on" | "off" | "cooldown";
  model?: string;
}

/** Envelope sent over WebSocket to clients (server → client). */
export type WsEnvelope =
  | { kind: "agent_event"; agentId: string; event: NormalizedEvent }
  | { kind: "agent_state_change"; agentId: string; state: AgentState }
  | { kind: "agents_list"; agents: AgentConfig[] }
  | { kind: "agent_created"; agent: AgentConfig }
  /** Metadata-only update to an existing agent (e.g. archive/unarchive).
   *  The client merges `agent` into its local record. */
  | { kind: "agent_updated"; agentId: string; agent: AgentConfig & { running?: boolean } }
  | { kind: "agent_removed"; agentId: string }
  | { kind: "agent_session_reset"; agentId: string }
  | { kind: "projects_list"; projects: ProjectConfig[] }
  | { kind: "project_created"; project: ProjectConfig }
  | { kind: "project_removed"; projectName: string }
  | { kind: "error"; message: string }
  /** A pi extension (most notably pi-cas-provider's AskUserQuestion bridge)
   *  asked the host UI to prompt the user. The client renders a modal and
   *  posts back an extension_ui_response (or extension_ui_cancel). Servers
   *  re-broadcast all pending requests to newly-connected clients so a
   *  refresh or zero-clients-at-fire-time doesn't strand the agent. */
  | { kind: "extension_ui_request"; agentId: string; request: ExtensionUIRequest }
  /** Server tells clients to close a previously-broadcast request modal —
   *  either because another client already answered (first-response-wins)
   *  or because the underlying tool was cancelled (AbortSignal). */
  | { kind: "extension_ui_cancel"; agentId: string; requestId: string }
  /** Fire-and-forget notification surfaced from an extension. Maps to
   *  ExtensionUIContext.notify(). */
  | {
      kind: "extension_ui_notify";
      agentId: string;
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  /** Persistent status line set by an extension (e.g. badge in the agent
   *  header). `text === null` clears the slot. Maps to setStatus(). */
  | {
      kind: "extension_ui_status";
      agentId: string;
      statusKey: string;
      statusText: string | null;
    }
  /** Global fast-mode badge state (pi-cas-provider's `pi:fast-mode`
   *  channel). Broadcast whenever it changes, and primed on connect.
   *  `state === null` means no fast-mode-capable provider has reported in
   *  yet (badge stays hidden). */
  | { kind: "fast_mode"; state: FastModeState | null };

/** Envelope sent over WebSocket from a client to the server. Kept separate
 *  from WsEnvelope so the server can validate the smaller, narrower union
 *  on the inbound path. */
export type ClientWsEnvelope =
  | {
      kind: "extension_ui_response";
      agentId: string;
      requestId: string;
      /** The user's answer. Shape depends on the originating request method:
       *    - select (single):   string  (chosen label)
       *    - select (multi):    string[] (chosen labels)
       *    - confirm:           boolean
       *    - input:             string
       *  Server is responsible for matching shape against the pending
       *  request's method. */
      value: string | string[] | boolean;
    }
  | { kind: "extension_ui_cancel"; agentId: string; requestId: string };

/** Payload describing an extension's prompt-the-user request. The
 *  discriminant is `method`. Pi's ExtensionUIContext has more methods
 *  (`custom`, `editor`, etc.) but those are TUI-only and not surfaced here. */
export type ExtensionUIRequest =
  | {
      requestId: string;
      method: "select";
      title: string;
      options: Array<{ label: string; description?: string }>;
      multi?: boolean;
    }
  | {
      requestId: string;
      method: "confirm";
      title: string;
      message?: string;
    }
  | {
      requestId: string;
      method: "input";
      title: string;
      placeholder?: string;
    };

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
  /** Image attachments. Forwarded into pi's `session.prompt({images})`
 *  so the model sees them as part of this user message. */
  images?: InboundImage[];
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
  /** Inline image attachments. Currently populated for user messages
   *  (pasted/dropped into the dashboard input) and tool_result messages
   *  whose pi content blocks include images. We send them inline as
   *  data URIs so the dashboard can render them with no extra fetches
   *  -- same way pi's JSONL session file stores them. Cap at
   *  MAX_IMAGES_PER_MESSAGE * MAX_IMAGE_BYTES on the inbound side. */
  images?: ChatImage[];
}

/** A single image attachment formatted for the frontend. */
export interface ChatImage {
  /** `data:<mime>;base64,<bytes>` ready to drop into an <img src=...>. */
  dataUrl: string;
  /** Same as the mime portion of dataUrl, broken out for the renderer
   *  (which uses it to label tool-result images and pick a placeholder
   *  icon for unsupported types). */
  mimeType: string;
}

/** Inbound image attachment on POST /api/agents/:id/message. The data
 *  field is a base64-encoded image; mimeType is the source mime type. */
export interface InboundImage {
  data: string;
  mimeType: string;
}
