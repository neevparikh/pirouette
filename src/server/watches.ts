/** Watches: wake an agent when something it's waiting on happens.
 *
 *  An agent that pushes a PR, starts a long build, or needs to check back
 *  in an hour otherwise has two bad options: block a tool call polling
 *  (and hit the bash timeout), or end its turn and hope somebody pokes it.
 *  A watch hands the waiting to the server. When it fires, the server
 *  sends the agent a message saying what happened, which starts a new
 *  turn (or is queued into the current one).
 *
 *  Kinds:
 *    - `timer`  fire after a delay ("check back in 2h").
 *    - `cmd`    run a shell command in the background; fire when it exits,
 *               with the exit code and the tail of its output.
 *    - `until`  re-run a shell command every N seconds; fire the first time
 *               it exits 0.
 *    - `pr`     poll a GitHub PR with `gh`; fire when its checks finish (or
 *               one fails), a review or comment lands, it's merged or
 *               closed, or it picks up a merge conflict.
 *
 *  Every watch fires once and is then gone. `until` and `pr` give up at a
 *  deadline (default 24h) and fire with "timed out", so an agent is never
 *  left waiting on something that will never come.
 *
 *  Watches persist in `<stateDir>/watches.json`, so `timer`, `until` and
 *  `pr` carry on across a server restart. A `cmd` doesn't: the restart
 *  kills the process (it's in the service's cgroup), so on boot the agent
 *  is told its command was killed, with whatever output it had produced.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types

export type WatchKind = "timer" | "cmd" | "until" | "pr";

/** Things a PR watch can fire on. */
export type PrEvent = "checks" | "reviews" | "merged" | "conflict";
export const PR_EVENTS: readonly PrEvent[] = ["checks", "reviews", "merged", "conflict"];

/** How the wake-up message is delivered if the agent is mid-turn. */
export type WatchDeliveryMode = "steer" | "followUp";

export interface PrBaseline {
  /** Review and comment ids that existed when the watch was set. Anything
   *  else that shows up later is new. */
  seenIds: string[];
  mergeable: string | null;
}

export interface Watch {
  id: string;
  /** Agent the message goes to. */
  agentId: string;
  /** Agent that set the watch, when it wasn't the user. Usually the same
   *  as `agentId`; differs when e.g. a crew agent watches on behalf of
   *  its captain. */
  createdBy: string | null;
  kind: WatchKind;
  /** Free text the setter left for whoever gets woken ("then rebase
   *  #12 onto it"). Echoed back in the message. */
  note: string | null;
  mode: WatchDeliveryMode;
  createdAt: string;
  /** When a timer fires, or when until/pr/cmd give up. Null: no limit
   *  (only `cmd` without `--timeout`). */
  deadline: string | null;
  /** Working directory for cmd / until / pr. */
  cwd: string | null;
  /** Shell command for cmd / until. */
  command: string | null;
  /** Poll interval for until / pr. */
  everyMs: number | null;
  /** PR number or URL, and optional `owner/repo`. */
  pr: string | null;
  repo: string | null;
  prEvents: PrEvent[] | null;
  prBaseline: PrBaseline | null;
  /** PID of a running `cmd` (the wrapper shell's process group). */
  pid: number | null;
  /** Consecutive failures of a poll (`gh` erroring, ...). */
  pollFailures: number;
  /** Set once the watch has fired: the message waiting to be delivered.
   *  Persisted so a restart between firing and delivery doesn't lose it. */
  firedText: string | null;
  /** The same without the model-facing header, for the dashboard. */
  firedBody: string | null;
  /** One-line summary of why it fired, for the dashboard label. */
  firedSummary: string | null;
  deliveryAttempts: number;
}

/** What `pru watch` sends to create one. Validated by `parseWatchRequest`. */
export interface WatchRequest {
  kind: WatchKind;
  note: string | null;
  mode: WatchDeliveryMode;
  createdBy: string | null;
  /** Timer delay, or the give-up deadline for the other kinds. */
  durationMs: number | null;
  cwd: string | null;
  command: string | null;
  everyMs: number | null;
  pr: string | null;
  repo: string | null;
  prEvents: PrEvent[] | null;
}

/** The message a fired watch delivers. */
export interface WatchMessage {
  watch: { id: string; kind: WatchKind; summary: string };
  /** Model-visible text, header included. */
  text: string;
  /** Text without the header, for the dashboard. */
  body: string;
  mode: WatchDeliveryMode;
}

// ---------------------------------------------------------------------------
// Limits and defaults

export const MAX_WATCH_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_POLL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MIN_EVERY_MS = 10_000;
export const DEFAULT_UNTIL_EVERY_MS = 60_000;
export const DEFAULT_PR_EVERY_MS = 60_000;
/** A single `until` / `gh` invocation gets this long before it's killed. */
export const POLL_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
/** Give up on a poll after this many failures in a row, and tell the agent. */
export const MAX_POLL_FAILURES = 5;
/** Retry delivery (agent won't resume, ...) this many times, a minute apart. */
export const MAX_DELIVERY_ATTEMPTS = 10;
export const NOTE_MAX = 2000;
export const COMMAND_MAX = 4000;
/** Output included in a message: the last this-many lines / chars. */
export const OUTPUT_TAIL_LINES = 40;
export const OUTPUT_TAIL_CHARS = 4000;
/** Node's setTimeout overflows past ~24.8 days; we re-arm in chunks. */
const MAX_TIMEOUT_CHUNK_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Durations

/** Parse "90", "90s", "5m", "2h", "1d", "1h30m". Bare numbers are seconds.
 *  Returns milliseconds, or null if it doesn't parse. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|w)/gy;
  const unit: Record<string, number> = {
    ms: 1,
    s: 1000,
    sec: 1000,
    secs: 1000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    d: 86_400_000,
    w: 7 * 86_400_000,
  };
  let total = 0;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    total += Number(m[1]) * unit[m[2]];
    pos = re.lastIndex;
  }
  if (pos !== s.length || total <= 0) return null;
  return Math.round(total);
}

/** "2h 5m", "45s", "3d 4h" — compact, for messages and `pru watch ls`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  let s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !d) parts.push(`${s}s`);
  return parts.slice(0, 2).join(" ") || "0s";
}

// ---------------------------------------------------------------------------
// Request validation

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate a POST /api/agents/:id/watches body. */
export function parseWatchRequest(raw: unknown): Parsed<WatchRequest> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = raw as Record<string, unknown>;
  const kind = b.kind;
  if (kind !== "timer" && kind !== "cmd" && kind !== "until" && kind !== "pr") {
    return { ok: false, error: "kind must be one of timer, cmd, until, pr" };
  }

  const optString = (key: string, max: number): Parsed<string | null> => {
    const v = b[key];
    if (v === undefined || v === null || v === "") return { ok: true, value: null };
    if (typeof v !== "string") return { ok: false, error: `${key} must be a string` };
    if (v.length > max) return { ok: false, error: `${key} must be at most ${max} characters` };
    return { ok: true, value: v };
  };
  const optMs = (key: string): Parsed<number | null> => {
    const v = b[key];
    if (v === undefined || v === null) return { ok: true, value: null };
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return { ok: false, error: `${key} must be a positive number of milliseconds` };
    }
    if (v > MAX_WATCH_MS) {
      return { ok: false, error: `${key} must be at most ${formatDuration(MAX_WATCH_MS)}` };
    }
    return { ok: true, value: Math.round(v) };
  };

  const note = optString("note", NOTE_MAX);
  if (!note.ok) return note;
  const createdBy = optString("createdBy", 64);
  if (!createdBy.ok) return createdBy;
  const cwd = optString("cwd", 4096);
  if (!cwd.ok) return cwd;
  const command = optString("command", COMMAND_MAX);
  if (!command.ok) return command;
  const pr = optString("pr", 512);
  if (!pr.ok) return pr;
  const repo = optString("repo", 512);
  if (!repo.ok) return repo;
  const durationMs = optMs("durationMs");
  if (!durationMs.ok) return durationMs;
  const everyMs = optMs("everyMs");
  if (!everyMs.ok) return everyMs;

  if (b.mode !== undefined && b.mode !== "steer" && b.mode !== "followUp") {
    return { ok: false, error: "mode must be steer or followUp" };
  }
  const mode: WatchDeliveryMode = b.mode === "steer" ? "steer" : "followUp";

  if (cwd.value !== null && !path.isAbsolute(cwd.value)) {
    return { ok: false, error: "cwd must be an absolute path" };
  }
  if (everyMs.value !== null && everyMs.value < MIN_EVERY_MS) {
    return { ok: false, error: `every must be at least ${formatDuration(MIN_EVERY_MS)}` };
  }

  let prEvents: PrEvent[] | null = null;
  if (kind === "timer") {
    if (durationMs.value === null) return { ok: false, error: "a timer needs durationMs" };
  } else if (kind === "cmd" || kind === "until") {
    if (!command.value || !command.value.trim()) {
      return { ok: false, error: `a ${kind} watch needs a command` };
    }
  } else {
    if (!pr.value) return { ok: false, error: "a pr watch needs pr (a number or URL)" };
    if (!/^#?\d+$/.test(pr.value) && !/^https?:\/\//.test(pr.value)) {
      return { ok: false, error: "pr must be a PR number or URL" };
    }
    if (repo.value !== null && !/^[\w.-]+\/[\w.-]+$/.test(repo.value)) {
      return { ok: false, error: "repo must look like owner/name" };
    }
    if (b.prEvents === undefined || b.prEvents === null) {
      prEvents = [...PR_EVENTS];
    } else {
      if (!Array.isArray(b.prEvents) || b.prEvents.length === 0) {
        return { ok: false, error: `prEvents must be a non-empty list of ${PR_EVENTS.join(", ")}` };
      }
      for (const e of b.prEvents) {
        if (!PR_EVENTS.includes(e as PrEvent)) {
          return { ok: false, error: `unknown PR event ${JSON.stringify(e)} (use ${PR_EVENTS.join(", ")})` };
        }
      }
      prEvents = [...new Set(b.prEvents as PrEvent[])];
    }
  }

  return {
    ok: true,
    value: {
      kind,
      note: note.value,
      mode,
      createdBy: createdBy.value,
      durationMs: durationMs.value,
      cwd: cwd.value,
      command: command.value,
      everyMs: everyMs.value,
      pr: pr.value ? pr.value.replace(/^#/, "") : null,
      repo: repo.value,
      prEvents,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers: describing a watch, building the wake-up message

/** Short description of what a watch is waiting for. */
export function describeWatch(w: Pick<Watch, "kind" | "command" | "pr" | "repo" | "prEvents" | "deadline" | "createdAt">): string {
  switch (w.kind) {
    case "timer": {
      const total = w.deadline ? Date.parse(w.deadline) - Date.parse(w.createdAt) : 0;
      return `timer (${formatDuration(total)})`;
    }
    case "cmd":
      return `command: ${truncate(w.command ?? "", 80)}`;
    case "until":
      return `until: ${truncate(w.command ?? "", 80)}`;
    case "pr": {
      const events =
        w.prEvents && w.prEvents.length < PR_EVENTS.length ? ` (${w.prEvents.join(", ")})` : "";
      return `PR ${prLabel(w.pr ?? "", w.repo)}${events}`;
    }
  }
}

function prLabel(pr: string, repo: string | null): string {
  if (/^\d+$/.test(pr)) return repo ? `${repo}#${pr}` : `#${pr}`;
  const m = pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : pr;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Last `OUTPUT_TAIL_LINES` lines / `OUTPUT_TAIL_CHARS` chars of output. */
export function tailOutput(output: string): string {
  let lines = output.replace(/\s+$/, "").split("\n");
  if (lines.length > OUTPUT_TAIL_LINES) lines = lines.slice(-OUTPUT_TAIL_LINES);
  let out = lines.join("\n");
  if (out.length > OUTPUT_TAIL_CHARS) out = `…${out.slice(-OUTPUT_TAIL_CHARS)}`;
  return out;
}

/** The message a fired watch sends. `summary` is one line ("PR #12: 2
 *  checks failed"); `details` is the rest (check list, output tail). */
export function buildWatchMessage(
  w: Pick<Watch, "id" | "kind" | "agentId" | "createdBy" | "note" | "createdAt" | "command" | "pr" | "repo" | "prEvents" | "deadline" | "mode">,
  summary: string,
  details: string,
  now: number = Date.now(),
): WatchMessage {
  const setBy =
    w.createdBy === null
      ? "the user set"
      : w.createdBy === w.agentId
        ? "you set"
        : `agent ${w.createdBy} set for you`;
  const age = formatDuration(now - Date.parse(w.createdAt));
  const header =
    `[Watch ${w.id} fired via pirouette, not typed by the user: a watch ${setBy} ${age} ago ` +
    `on ${describeWatch(w)}. It has now finished; set a new one (pru watch ...) if you need to keep waiting.]`;
  const parts = [summary];
  if (w.note) parts.push(`Note left with the watch: ${w.note}`);
  if (details.trim()) parts.push(details.replace(/\s+$/, ""));
  const body = parts.join("\n\n");
  return {
    watch: { id: w.id, kind: w.kind, summary },
    text: `${header}\n\n${body}`,
    body,
    mode: w.mode,
  };
}

// ---------------------------------------------------------------------------
// PR evaluation (pure, so it can be tested without `gh`)

/** The subset of `gh pr view --json ...` a PR watch reads. */
export interface PrSnapshot {
  number?: number;
  url?: string;
  title?: string;
  state?: string; // OPEN | MERGED | CLOSED
  mergeable?: string; // MERGEABLE | CONFLICTING | UNKNOWN
  statusCheckRollup?: Array<{
    __typename?: string;
    name?: string;
    context?: string;
    workflowName?: string;
    status?: string; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED | ...
    conclusion?: string | null; // CheckRun: SUCCESS | FAILURE | ...
    state?: string; // StatusContext: SUCCESS | PENDING | FAILURE | ERROR | EXPECTED
    detailsUrl?: string;
    targetUrl?: string;
  }> | null;
  reviews?: Array<{ id?: string; author?: { login?: string } | null; state?: string; body?: string; submittedAt?: string }> | null;
  comments?: Array<{ id?: string; author?: { login?: string } | null; body?: string; createdAt?: string; url?: string }> | null;
}

export const PR_JSON_FIELDS =
  "number,url,title,state,mergeable,statusCheckRollup,reviews,comments";

type CheckOutcome = "pass" | "fail" | "pending" | "skip";

interface CheckRow {
  name: string;
  outcome: CheckOutcome;
  detail: string;
  url: string | null;
}

const FAIL_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);
const SKIP_CONCLUSIONS = new Set(["SKIPPED", "NEUTRAL", "STALE"]);

function checkRows(snap: PrSnapshot): CheckRow[] {
  const rows: CheckRow[] = [];
  for (const c of snap.statusCheckRollup ?? []) {
    if (c.__typename === "StatusContext" || (c.context && !c.name)) {
      const st = (c.state ?? "").toUpperCase();
      rows.push({
        name: c.context ?? "status",
        outcome:
          st === "SUCCESS" ? "pass" : st === "FAILURE" || st === "ERROR" ? "fail" : "pending",
        detail: st || "PENDING",
        url: c.targetUrl ?? null,
      });
    } else {
      const status = (c.status ?? "").toUpperCase();
      const conclusion = (c.conclusion ?? "").toUpperCase();
      let outcome: CheckOutcome;
      if (status !== "COMPLETED") outcome = "pending";
      else if (FAIL_CONCLUSIONS.has(conclusion)) outcome = "fail";
      else if (SKIP_CONCLUSIONS.has(conclusion)) outcome = "skip";
      else outcome = "pass";
      const name = c.workflowName && c.name ? `${c.workflowName} / ${c.name}` : (c.name ?? "check");
      rows.push({
        name,
        outcome,
        detail: status === "COMPLETED" ? conclusion || "COMPLETED" : status || "PENDING",
        url: c.detailsUrl ?? null,
      });
    }
  }
  return rows;
}

/** Ids of all reviews and comments, for the baseline. */
export function prActivityIds(snap: PrSnapshot): string[] {
  const ids: string[] = [];
  for (const r of snap.reviews ?? []) if (r.id) ids.push(r.id);
  for (const c of snap.comments ?? []) if (c.id) ids.push(c.id);
  return ids;
}

export function prBaseline(snap: PrSnapshot): PrBaseline {
  return { seenIds: prActivityIds(snap), mergeable: snap.mergeable ?? null };
}

/** Decide whether a PR watch fires on this snapshot. Returns null to keep
 *  waiting, or the summary + details of the message. */
export function evaluatePr(
  snap: PrSnapshot,
  baseline: PrBaseline,
  events: readonly PrEvent[],
): { summary: string; details: string } | null {
  const label = snap.number ? `PR #${snap.number}` : "PR";
  const head = [snap.title ? `${label} "${snap.title}"` : label, snap.url].filter(Boolean).join(" ");
  const reasons: string[] = [];
  const details: string[] = [head];

  const state = (snap.state ?? "").toUpperCase();
  if (events.includes("merged") && (state === "MERGED" || state === "CLOSED")) {
    reasons.push(state === "MERGED" ? "was merged" : "was closed without merging");
  }

  if (
    events.includes("conflict") &&
    snap.mergeable === "CONFLICTING" &&
    baseline.mergeable !== "CONFLICTING" &&
    state === "OPEN"
  ) {
    reasons.push("has a merge conflict with its base branch");
  }

  if (events.includes("reviews")) {
    const seen = new Set(baseline.seenIds);
    const lines: string[] = [];
    for (const r of snap.reviews ?? []) {
      if (!r.id || seen.has(r.id)) continue;
      const body = r.body?.trim() ? `: ${truncate(r.body, 300)}` : "";
      lines.push(`- review by ${r.author?.login ?? "someone"} (${r.state ?? "COMMENTED"})${body}`);
    }
    for (const c of snap.comments ?? []) {
      if (!c.id || seen.has(c.id)) continue;
      lines.push(`- comment by ${c.author?.login ?? "someone"}: ${truncate(c.body ?? "", 300)}`);
    }
    if (lines.length > 0) {
      reasons.push(lines.length === 1 ? "got a new review/comment" : `got ${lines.length} new reviews/comments`);
      details.push(
        `New activity (inline review comments aren't shown here; read them with gh):\n${lines.join("\n")}`,
      );
    }
  }

  const rows = checkRows(snap);
  const failed = rows.filter((r) => r.outcome === "fail");
  const pending = rows.filter((r) => r.outcome === "pending");
  const passed = rows.filter((r) => r.outcome === "pass" || r.outcome === "skip");
  let checksFired = false;
  if (events.includes("checks") && state === "OPEN" && rows.length > 0) {
    if (failed.length > 0) {
      reasons.push(
        `${failed.length} check${failed.length === 1 ? "" : "s"} failed` +
          (pending.length ? ` (${pending.length} still running)` : ""),
      );
      checksFired = true;
    } else if (pending.length === 0) {
      reasons.push(`all ${rows.length} check${rows.length === 1 ? "" : "s"} passed`);
      checksFired = true;
    }
  }
  if (reasons.length === 0) return null;

  // Show the check table whenever there's something to say about checks,
  // even if the watch fired for another reason: it's what the agent will
  // want to know next.
  if (rows.length > 0 && (checksFired || failed.length > 0 || pending.length > 0)) {
    const lines = [
      ...failed.map((r) => `✗ ${r.name}: ${r.detail}${r.url ? ` ${r.url}` : ""}`),
      ...pending.map((r) => `… ${r.name}: ${r.detail}`),
    ];
    if (passed.length) lines.push(`✓ ${passed.length} passed/skipped`);
    details.push(`Checks:\n${lines.join("\n")}`);
    if (failed.length) details.push("Failed logs: gh run view <run-id> --log-failed");
  }

  return { summary: `${label} ${joinReasons(reasons)}.`, details: details.join("\n\n") };
}

function joinReasons(rs: string[]): string {
  if (rs.length <= 1) return rs.join("");
  return `${rs.slice(0, -1).join(", ")} and ${rs[rs.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Running commands

export interface CommandResult {
  code: number | null;
  signal: string | null;
  output: string;
  timedOut: boolean;
}

/** Run `bash -c <command>` to completion, with a time limit. Used for
 *  `until` polls and `gh`. Output is stdout+stderr interleaved, capped. */
export type CommandRunner = (
  command: string,
  args: string[] | null,
  cwd: string | null,
  timeoutMs: number,
) => Promise<CommandResult>;

const OUTPUT_CAP = 1024 * 1024;

export const runCommand: CommandRunner = (command, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const child =
      args === null
        ? spawn("bash", ["-c", command], { cwd: cwd ?? undefined, detached: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(command, args, { cwd: cwd ?? undefined, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const onData = (d: Buffer) => {
      if (output.length < OUTPUT_CAP) output += d.toString("utf8");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, output: `${output}${err.message}`, timedOut: false });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });

function killGroup(pid: number | undefined | null, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// The manager

export interface WatchManagerDeps {
  /** Directory for watches.json and cmd output logs. */
  stateDir: string;
  /** Deliver a fired watch's message. Throws if it couldn't (agent won't
   *  resume, ...); the manager retries. */
  deliver: (agentId: string, message: WatchMessage) => Promise<void>;
  /** False once an agent has been removed: its watches are dropped. */
  agentExists: (agentId: string) => boolean;
  run?: CommandRunner;
  now?: () => number;
  /** Delay between delivery retries. */
  retryMs?: number;
}

interface WatchFile {
  nextId: number;
  watches: Watch[];
}

export class WatchManager {
  private watches = new Map<string, Watch>();
  private nextId = 1;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** cmd watches whose process this server spawned (vs. adopted on boot). */
  private children = new Set<string>();
  /** Polls in flight, so a slow `gh` isn't run twice at once. */
  private polling = new Set<string>();
  private saveChain: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly run: CommandRunner;
  private readonly now: () => number;
  private readonly retryMs: number;

  constructor(private readonly deps: WatchManagerDeps) {
    this.run = deps.run ?? runCommand;
    this.now = deps.now ?? Date.now;
    this.retryMs = deps.retryMs ?? 60_000;
  }

  get filePath(): string {
    return path.join(this.deps.stateDir, "watches.json");
  }

  logPath(id: string): string {
    return path.join(this.deps.stateDir, "watch-logs", `${id}.log`);
  }

  private exitPath(id: string): string {
    return path.join(this.deps.stateDir, "watch-logs", `${id}.exit`);
  }

  /** Load persisted watches and start them. A cmd watch from before the
   *  restart is reported as killed (or finished, if its exit code made it
   *  to disk). */
  async start(): Promise<void> {
    let file: WatchFile | null = null;
    try {
      file = JSON.parse(await readFile(this.filePath, "utf8")) as WatchFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[watches] could not read ${this.filePath}: ${(err as Error).message}`);
      }
    }
    if (file && Array.isArray(file.watches)) {
      this.nextId = Math.max(1, Number(file.nextId) || 1);
      for (const w of file.watches) {
        if (w && typeof w.id === "string") this.watches.set(w.id, { ...w });
      }
    }
    for (const w of this.watches.values()) this.schedule(w, 0);
    if (this.watches.size) console.log(`[watches] resumed ${this.watches.size} watch(es)`);
  }

  /** Stop timers. Running cmd processes are left alone: a restart kills
   *  them anyway, and the next boot reports it. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.saveChain;
  }

  list(agentId?: string): Watch[] {
    return [...this.watches.values()]
      .filter((w) => !agentId || w.agentId === agentId)
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }

  get(id: string): Watch | undefined {
    return this.watches.get(id);
  }

  /** Create a watch for `agentId`. For a PR watch, reads the PR once up
   *  front, so a typo fails here rather than an hour later, and so
   *  reviews that already exist don't count as new. If the PR already
   *  satisfies the watch (checks already finished), it fires right away;
   *  the returned watch then has `firedSummary` set. */
  async create(agentId: string, req: WatchRequest): Promise<Watch> {
    const now = this.now();
    // The id is only taken once the watch is known to be good (below), so
    // a rejected PR doesn't burn a number.
    const id = "";
    let deadlineMs: number | null;
    if (req.kind === "timer") deadlineMs = now + (req.durationMs ?? 0);
    else if (req.kind === "cmd") deadlineMs = req.durationMs ? now + req.durationMs : null;
    else deadlineMs = now + (req.durationMs ?? DEFAULT_POLL_TIMEOUT_MS);

    const w: Watch = {
      id,
      agentId,
      createdBy: req.createdBy,
      kind: req.kind,
      note: req.note,
      mode: req.mode,
      createdAt: new Date(now).toISOString(),
      deadline: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
      cwd: req.cwd,
      command: req.command,
      everyMs:
        req.kind === "until"
          ? (req.everyMs ?? DEFAULT_UNTIL_EVERY_MS)
          : req.kind === "pr"
            ? (req.everyMs ?? DEFAULT_PR_EVERY_MS)
            : null,
      pr: req.pr,
      repo: req.repo,
      prEvents: req.prEvents,
      prBaseline: null,
      pid: null,
      pollFailures: 0,
      firedText: null,
      firedBody: null,
      firedSummary: null,
      deliveryAttempts: 0,
    };

    if (w.cwd && !existsSync(w.cwd)) throw new Error(`cwd does not exist: ${w.cwd}`);

    let firstPoll: PrSnapshot | null = null;
    if (w.kind === "pr") {
      firstPoll = await this.fetchPr(w); // throws with gh's message
      w.prBaseline = prBaseline(firstPoll);
    }

    w.id = `w${this.nextId++}`;
    this.watches.set(w.id, w);
    if (w.kind === "cmd") this.startCommand(w);
    if (firstPoll) {
      const hit = evaluatePr(firstPoll, w.prBaseline!, w.prEvents ?? PR_EVENTS);
      if (hit) {
        this.fire(w, hit.summary, hit.details);
        return { ...w };
      }
    }
    this.save();
    if (w.kind !== "cmd") this.schedule(w, w.kind === "timer" ? deadlineMs! - now : w.everyMs!);
    else if (w.deadline) this.schedule(w, Date.parse(w.deadline) - now);
    return { ...w };
  }

  /** Cancel a watch. Kills a running cmd. Returns false if unknown. */
  cancel(id: string): boolean {
    const w = this.watches.get(id);
    if (!w) return false;
    this.clearTimer(id);
    if (w.kind === "cmd" && w.pid && !w.firedText) killGroup(w.pid);
    this.children.delete(id);
    this.watches.delete(id);
    this.save();
    return true;
  }

  /** Move an agent's watches to another agent (after a handoff, the
   *  successor gets woken instead). Returns how many moved. */
  reassign(fromAgentId: string, toAgentId: string): number {
    let n = 0;
    for (const w of this.watches.values()) {
      if (w.agentId !== fromAgentId) continue;
      w.agentId = toAgentId;
      if (w.createdBy === fromAgentId) w.createdBy = toAgentId;
      n++;
    }
    if (n) this.save();
    return n;
  }

  /** Drop every watch belonging to an agent (it was removed). */
  cancelForAgent(agentId: string): number {
    let n = 0;
    for (const w of this.list(agentId)) if (this.cancel(w.id)) n++;
    return n;
  }

  // ---- scheduling ------------------------------------------------------

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private schedule(w: Watch, delayMs: number): void {
    if (this.stopped) return;
    this.clearTimer(w.id);
    const delay = Math.max(0, Math.min(delayMs, MAX_TIMEOUT_CHUNK_MS));
    const t = setTimeout(() => {
      this.timers.delete(w.id);
      void this.tick(w.id);
    }, delay);
    t.unref?.();
    this.timers.set(w.id, t);
  }

  /** One wake-up for a watch: deliver if it already fired, else check it. */
  private async tick(id: string): Promise<void> {
    const w = this.watches.get(id);
    if (!w || this.stopped) return;
    if (!this.deps.agentExists(w.agentId)) {
      console.log(`[watches] dropping ${w.id}: agent ${w.agentId} no longer exists`);
      this.cancel(w.id);
      return;
    }
    if (w.firedText !== null) {
      await this.tryDeliver(w);
      return;
    }
    const now = this.now();
    const deadline = w.deadline ? Date.parse(w.deadline) : null;

    switch (w.kind) {
      case "timer":
        if (deadline !== null && now < deadline) {
          this.schedule(w, deadline - now);
          return;
        }
        this.fire(w, `Timer finished (${formatDuration(now - Date.parse(w.createdAt))}).`, "");
        return;

      case "cmd":
        this.checkCommand(w, now, deadline);
        return;

      case "until":
      case "pr":
        if (deadline !== null && now >= deadline) {
          this.fire(
            w,
            `Gave up: ${describeWatch(w)} didn't happen within ${formatDuration(deadline - Date.parse(w.createdAt))}.`,
            "",
          );
          return;
        }
        await this.poll(w);
        return;
    }
  }

  private async poll(w: Watch): Promise<void> {
    if (this.polling.has(w.id)) return;
    this.polling.add(w.id);
    try {
      if (w.kind === "until") {
        const r = await this.run(w.command!, null, w.cwd, POLL_COMMAND_TIMEOUT_MS);
        if (!this.watches.has(w.id)) return; // cancelled meanwhile
        if (r.code === 0) {
          const out = tailOutput(r.output);
          this.fire(
            w,
            `Condition met: \`${truncate(w.command!, 200)}\` exited 0.`,
            out ? `Output:\n\`\`\`\n${out}\n\`\`\`` : "",
          );
          return;
        }
        // Non-zero is the normal "not yet". A command that can't even
        // start (bash missing, cwd gone) shows up as code null.
        if (r.code === null && !r.timedOut) {
          this.pollFailed(w, `couldn't run the command: ${tailOutput(r.output)}`);
          return;
        }
        w.pollFailures = 0;
      } else {
        let snap: PrSnapshot;
        try {
          snap = await this.fetchPr(w);
        } catch (err) {
          if (!this.watches.has(w.id)) return;
          this.pollFailed(w, err instanceof Error ? err.message : String(err));
          return;
        }
        if (!this.watches.has(w.id)) return;
        w.pollFailures = 0;
        const hit = evaluatePr(snap, w.prBaseline ?? prBaseline({}), w.prEvents ?? PR_EVENTS);
        if (hit) {
          this.fire(w, hit.summary, hit.details);
          return;
        }
      }
      this.schedule(w, w.everyMs ?? DEFAULT_UNTIL_EVERY_MS);
    } finally {
      this.polling.delete(w.id);
    }
  }

  private pollFailed(w: Watch, reason: string): void {
    w.pollFailures += 1;
    console.warn(`[watches] ${w.id} poll failed (${w.pollFailures}/${MAX_POLL_FAILURES}): ${reason}`);
    if (w.pollFailures >= MAX_POLL_FAILURES) {
      this.fire(w, `Gave up: checking ${describeWatch(w)} failed ${w.pollFailures} times in a row.`, `Last error:\n${reason}`);
      return;
    }
    this.save();
    this.schedule(w, w.everyMs ?? DEFAULT_UNTIL_EVERY_MS);
  }

  private async fetchPr(w: Watch): Promise<PrSnapshot> {
    const args = ["pr", "view", w.pr!, "--json", PR_JSON_FIELDS];
    if (w.repo) args.push("--repo", w.repo);
    const r = await this.run("gh", args, w.cwd, POLL_COMMAND_TIMEOUT_MS);
    if (r.code !== 0) {
      throw new Error(`gh ${args.join(" ")} failed: ${tailOutput(r.output) || `exit ${r.code}`}`);
    }
    try {
      return JSON.parse(r.output) as PrSnapshot;
    } catch {
      throw new Error(`gh returned something that isn't JSON: ${truncate(r.output, 200)}`);
    }
  }

  // ---- cmd -------------------------------------------------------------

  private startCommand(w: Watch): void {
    const logDir = path.dirname(this.logPath(w.id));
    mkdirSync(logDir, { recursive: true });
    const fd = openSync(this.logPath(w.id), "w");
    // The wrapper records the exit code on disk, so a server that
    // restarts while the command keeps going (dev setups without
    // systemd) can still tell how it ended.
    const wrapper = 'bash -c "$1"; code=$?; echo "$code" > "$2"; exit "$code"';
    const child = spawn("bash", ["-c", wrapper, "pru-watch", w.command!, this.exitPath(w.id)], {
      cwd: w.cwd ?? undefined,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    w.pid = child.pid ?? null;
    this.children.add(w.id);
    child.on("error", (err) => {
      if (!this.watches.has(w.id)) return;
      this.children.delete(w.id);
      this.fire(w, `Command failed to start: ${err.message}`, "");
    });
    child.on("exit", (code, signal) => {
      this.children.delete(w.id);
      const cur = this.watches.get(w.id);
      if (!cur || cur.firedText !== null) return;
      this.finishCommand(cur, code, signal);
    });
    console.log(`[watches] ${w.id} started command (pid ${w.pid}) for ${w.agentId}`);
  }

  private finishCommand(w: Watch, code: number | null, signal: string | null): void {
    const out = this.readLogTail(w.id);
    const how =
      code !== null ? `exited with code ${code}` : signal ? `was killed by ${signal}` : "ended";
    this.fire(
      w,
      `Command ${how}: \`${truncate(w.command!, 200)}\``,
      [
        out ? `Last output:\n\`\`\`\n${out}\n\`\`\`` : "It printed nothing.",
        `Full output: ${this.logPath(w.id)}`,
      ].join("\n\n"),
    );
  }

  /** A cmd watch's timer fired: the deadline, or a boot-time check of a
   *  command this server didn't start. */
  private checkCommand(w: Watch, now: number, deadline: number | null): void {
    if (!this.children.has(w.id)) {
      // Started by a previous server process.
      const exitFile = this.exitPath(w.id);
      if (existsSync(exitFile)) {
        const code = Number(readFileSync(exitFile, "utf8").trim());
        this.finishCommand(w, Number.isFinite(code) ? code : null, null);
        return;
      }
      if (!pidAlive(w.pid)) {
        const out = this.readLogTail(w.id);
        this.fire(
          w,
          `Command was killed when the pirouette server restarted, before it finished: \`${truncate(w.command!, 200)}\`. Re-run it if you still need it.`,
          [out ? `Output before the restart:\n\`\`\`\n${out}\n\`\`\`` : "", `Full output: ${this.logPath(w.id)}`]
            .filter(Boolean)
            .join("\n\n"),
        );
        return;
      }
    }
    if (deadline !== null && now >= deadline) {
      killGroup(w.pid);
      // The exit handler (or the next tick, for an adopted process) reports
      // it; say why first.
      const out = this.readLogTail(w.id);
      this.children.delete(w.id);
      this.fire(
        w,
        `Command timed out after ${formatDuration(deadline - Date.parse(w.createdAt))} and was killed: \`${truncate(w.command!, 200)}\``,
        [out ? `Last output:\n\`\`\`\n${out}\n\`\`\`` : "", `Full output: ${this.logPath(w.id)}`]
          .filter(Boolean)
          .join("\n\n"),
      );
      return;
    }
    // Still running: check again later (adopted processes need polling;
    // our own children report through the exit handler).
    const next = this.children.has(w.id) ? (deadline !== null ? deadline - now : MAX_TIMEOUT_CHUNK_MS) : 15_000;
    this.schedule(w, deadline !== null ? Math.min(next, deadline - now) : next);
  }

  private readLogTail(id: string): string {
    try {
      return tailOutput(readFileSync(this.logPath(id), "utf8"));
    } catch {
      return "";
    }
  }

  // ---- firing + delivery ----------------------------------------------

  private fire(w: Watch, summary: string, details: string): void {
    this.clearTimer(w.id);
    const msg = buildWatchMessage(w, summary, details, this.now());
    w.firedText = msg.text;
    w.firedBody = msg.body;
    w.firedSummary = summary;
    console.log(`[watches] ${w.id} fired for ${w.agentId}: ${summary}`);
    this.save();
    // Shutting down: the message is on disk, and the next boot delivers it.
    if (!this.stopped) void this.tryDeliver(w);
  }

  private async tryDeliver(w: Watch): Promise<void> {
    if (w.firedText === null) return;
    const message: WatchMessage = {
      watch: { id: w.id, kind: w.kind, summary: w.firedSummary ?? "" },
      text: w.firedText,
      body: w.firedBody ?? w.firedText,
      mode: w.mode,
    };
    try {
      await this.deps.deliver(w.agentId, message);
      this.watches.delete(w.id);
      this.save();
      void rm(this.exitPath(w.id), { force: true }).catch(() => {});
    } catch (err) {
      w.deliveryAttempts += 1;
      const reason = err instanceof Error ? err.message : String(err);
      if (w.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS || !this.deps.agentExists(w.agentId)) {
        console.error(`[watches] giving up delivering ${w.id} to ${w.agentId}: ${reason}`);
        this.watches.delete(w.id);
      } else {
        console.warn(`[watches] delivering ${w.id} to ${w.agentId} failed (${w.deliveryAttempts}): ${reason}`);
        this.schedule(w, this.retryMs);
      }
      this.save();
    }
  }

  // ---- persistence -----------------------------------------------------

  /** Serialised atomic write of the whole file. */
  private save(): void {
    const snapshot: WatchFile = { nextId: this.nextId, watches: this.list() };
    this.saveChain = this.saveChain
      .then(async () => {
        await mkdir(this.deps.stateDir, { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        await writeFile(tmp, JSON.stringify(snapshot, null, 2));
        await rename(tmp, this.filePath);
      })
      .catch((err) => console.error(`[watches] save failed: ${(err as Error).message}`));
  }

  /** Resolves once pending writes have hit disk (tests). */
  flush(): Promise<void> {
    return this.saveChain;
  }
}
