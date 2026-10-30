/** Move a running `bash` tool call into the background.
 *
 *  Pi delivers a message sent mid-turn only after the turn's tool calls
 *  finish. So if an agent is sitting in a five-minute build, a message to it
 *  waits five minutes, and the only way to get its attention sooner is to
 *  interrupt, which kills the build. Telling agents to background long
 *  commands helps, but they don't always know in advance which commands
 *  will be long.
 *
 *  So pirouette swaps pi's `bash` tool for one whose command can be
 *  detached while it runs. When it detaches:
 *
 *    - the tool call returns at once, with the output so far and a note
 *      saying the command is still running and where its output goes;
 *    - the process keeps running, unaffected by the tool's timeout or by
 *      the turn being aborted;
 *    - a `cmd` watch adopts it (watches.ts), so the agent gets a message
 *      with the exit code and the end of the output when it finishes.
 *
 *  A detach happens when a message arrives for the agent (see
 *  `AgentManager.sendMessage`), or on request (`pru bg`, the dashboard).
 *
 *  To make that possible, the process can't write into a pipe owned by the
 *  tool call: when the tool call returns, nobody reads that pipe and the
 *  process gets SIGPIPE. Instead, its stdout and stderr go straight to a log
 *  file, and while the tool call is attached we read new output from the
 *  file and pass it to pi's tool as if it came from a pipe. A small wrapper
 *  shell writes the exit code next to the log, so a server restart can
 *  still tell how a detached command ended (same as `pru watch cmd`).
 *
 *  Everything else (output truncation, the temp file for long output,
 *  rendering, `PI_*` env vars, `shellCommandPrefix`, the bash-timeout
 *  extension's hooks) is pi's own tool: we only replace how the command is
 *  run, via pi's `BashOperations`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants, closeSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  createBashToolDefinition,
  getShellConfig,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

type BashToolDefinition = ReturnType<typeof createBashToolDefinition>;

// ---------------------------------------------------------------------------
// Policy

/** Wait at least this long into a command before detaching it for a
 *  message. Most commands finish within a few seconds, and then there's
 *  nothing to gain by detaching: pi delivers the message as soon as the
 *  tool call returns anyway. */
export const DEFAULT_BACKGROUND_GRACE_SECONDS = 5;

/** `[defaults.bash_background]` as written in TOML. All fields optional. */
export interface BashBackgroundConfig {
  auto_on_message?: boolean | string;
  grace_seconds?: number | string;
}

export interface BashBackgroundPolicy {
  /** Detach running bash commands when a message arrives mid-turn. */
  autoOnMessage: boolean;
  /** Minimum run time before a command is detached for a message. */
  graceSeconds: number;
}

function parseBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return null;
}

/** Build the policy from `[defaults.bash_background]` plus env overrides
 *  (`PIROUETTE_BASH_AUTO_BACKGROUND`, `PIROUETTE_BASH_BACKGROUND_GRACE_SECONDS`).
 *  Bad values are ignored with a warning, as for the bash timeout. */
export function resolveBashBackgroundPolicy(
  config: BashBackgroundConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { policy: BashBackgroundPolicy; warnings: string[] } {
  const warnings: string[] = [];
  let autoOnMessage = true;
  const rawAuto = env.PIROUETTE_BASH_AUTO_BACKGROUND ?? config?.auto_on_message;
  if (rawAuto !== undefined && rawAuto !== "") {
    const parsed = parseBool(rawAuto);
    if (parsed === null) {
      warnings.push(`ignoring bash_background.auto_on_message=${JSON.stringify(rawAuto)}: expected true or false`);
    } else {
      autoOnMessage = parsed;
    }
  }
  let graceSeconds = DEFAULT_BACKGROUND_GRACE_SECONDS;
  const rawGrace = env.PIROUETTE_BASH_BACKGROUND_GRACE_SECONDS ?? config?.grace_seconds;
  if (rawGrace !== undefined && rawGrace !== "") {
    const n = typeof rawGrace === "number" ? rawGrace : Number(String(rawGrace).trim());
    if (!Number.isFinite(n) || n < 0) {
      warnings.push(
        `ignoring bash_background.grace_seconds=${JSON.stringify(rawGrace)}: expected a non-negative number of seconds`,
      );
    } else {
      graceSeconds = n;
    }
  }
  return { policy: { autoOnMessage, graceSeconds }, warnings };
}

/** System prompt section, so an agent isn't surprised when a command it
 *  started comes back early with a note instead of an exit code. */
export function bashBackgroundGuidance(policy: BashBackgroundPolicy): string {
  const lines = [
    "## Commands moved to the background",
    "",
    "A `bash` call can come back before its command has finished, ending in a `[pirouette] Moved to the" +
      " background ...` note. The command is still running; a watch named in the note will message you" +
      " with its exit code and the end of its output when it exits. Don't re-run it and don't poll it:" +
      " deal with whatever arrived and carry on.",
  ];
  if (policy.autoOnMessage) {
    lines.push(
      "",
      "This happens when someone sends you a message while a command has been running for more than " +
        `${policy.graceSeconds}s, so that the message reaches you without waiting for the command.` +
        " It can also be requested by the user at any time.",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Jobs

/** A bash tool call that pirouette is running. */
export interface BashJob {
  agentId: string;
  toolCallId: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: number;
  logPath: string;
  exitPath: string;
  /** The wrapper shell. Exposed so whoever adopts a detached job can wait
   *  on its exit event rather than polling the pid. */
  child: ChildProcess;
}

/** Public view of a running job, for the API. */
export interface BashJobInfo {
  toolCallId: string;
  command: string;
  pid: number;
  startedAt: string;
}

/** What the adopter returns: how the tool result should refer to the
 *  watch that now owns the job. */
export interface AdoptedJob {
  watchId: string;
}

export interface DetachResult {
  /** Jobs detached right now. */
  detached: number;
  /** Jobs younger than the grace period, to be detached once they reach
   *  it (unless they finish first). */
  scheduled: number;
}

type JobState = "attached" | "detached" | "done";

interface LiveJob extends BashJob {
  state: JobState;
  /** Resolves the tool's `exec` early. */
  release: () => void;
  /** Why it was detached, for the tool result. */
  reason: string | null;
  adopted: AdoptedJob | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

export interface BashJobRegistryOptions {
  /** Where log and exit files live while a command runs. */
  jobDir: string;
  /** Hand a detached job to whoever wakes the agent when it exits. Called
   *  synchronously at detach time; returns the watch id, or throws (the
   *  tool result then says nobody will report the exit). */
  adopt: (job: BashJob) => AdoptedJob;
  log?: (message: string) => void;
  now?: () => number;
}

/** The wrapper writes the command's exit status to `$1` once it ends, so a
 *  restarted server can tell how a detached command finished. `$2...` is
 *  the shell invocation (e.g. `/bin/bash -c <command>`). */
const WRAPPER = 'exit_file=$1; shift; "$@"; code=$?; echo "$code" > "$exit_file"; exit "$code"';

/** How often an attached job's log is read for new output. */
const TAIL_INTERVAL_MS = 100;

function killGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
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

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "call";
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** The note appended to the result of a detached tool call. */
export function detachNote(job: Pick<BashJob, "pid" | "logPath">, opts: {
  reason: string;
  ranForMs: number;
  watchId: string | null;
  adoptError?: string;
}): string {
  const lines = [
    `[pirouette] Moved to the background after ${formatAge(opts.ranForMs)} because ${opts.reason}. ` +
      `The command is still running (pid ${job.pid}); the output above is what it had printed so far, ` +
      `and the rest goes to ${job.logPath}.`,
  ];
  if (opts.watchId) {
    lines.push(
      `Watch ${opts.watchId} will message you when it exits, with the exit code and the end of the output, ` +
        `so you don't need to poll it. Stop it with \`pru watch rm ${opts.watchId}\`.`,
    );
  } else {
    lines.push(
      `Nothing will tell you when it exits${opts.adoptError ? ` (${opts.adoptError})` : ""}; ` +
        `check with \`kill -0 ${job.pid}\` and read the log.`,
    );
  }
  lines.push("Carry on with your turn (if a message arrived, it comes next); don't re-run the command.");
  return lines.join("\n");
}

/** Every agent's in-flight bash tool calls, and the tool that creates them. */
export class BashJobRegistry {
  private readonly jobs = new Map<string, Set<LiveJob>>();
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: BashJobRegistryOptions) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** Running (still attached) jobs for an agent. */
  running(agentId: string): BashJobInfo[] {
    return [...(this.jobs.get(agentId) ?? [])]
      .filter((j) => j.state === "attached")
      .map((j) => ({
        toolCallId: j.toolCallId,
        command: j.command,
        pid: j.pid,
        startedAt: new Date(j.startedAt).toISOString(),
      }));
  }

  /** Detach an agent's running bash commands. Commands younger than
   *  `graceMs` are detached when they reach it, if they're still running
   *  then. */
  detach(agentId: string, opts: { reason: string; graceMs?: number }): DetachResult {
    const result: DetachResult = { detached: 0, scheduled: 0 };
    const graceMs = opts.graceMs ?? 0;
    for (const job of this.jobs.get(agentId) ?? []) {
      if (job.state !== "attached") continue;
      const wait = job.startedAt + graceMs - this.now();
      if (wait <= 0) {
        if (this.detachJob(job, opts.reason)) result.detached++;
        continue;
      }
      // Already scheduled by an earlier message: keep the earlier time.
      if (job.graceTimer) {
        result.scheduled++;
        continue;
      }
      job.graceTimer = setTimeout(() => {
        job.graceTimer = null;
        this.detachJob(job, opts.reason);
      }, wait);
      job.graceTimer.unref?.();
      result.scheduled++;
    }
    return result;
  }

  private detachJob(job: LiveJob, reason: string): boolean {
    if (job.state !== "attached") return false;
    // The process has exited but the exit event hasn't run yet: let the
    // tool call finish normally.
    if (job.child.exitCode !== null || job.child.signalCode !== null) return false;
    job.state = "detached";
    job.reason = reason;
    if (job.graceTimer) {
      clearTimeout(job.graceTimer);
      job.graceTimer = null;
    }
    try {
      job.adopted = this.opts.adopt(job);
    } catch (err) {
      this.log(`[bash-background] could not hand ${job.toolCallId} to a watch: ${err instanceof Error ? err.message : err}`);
      job.adopted = null;
    }
    this.log(
      `[bash-background] detached ${job.toolCallId} for ${job.agentId} (pid ${job.pid}, ` +
        `${formatAge(this.now() - job.startedAt)}) because ${reason}` +
        (job.adopted ? `; watch ${job.adopted.watchId}` : ""),
    );
    job.release();
    return true;
  }

  private add(job: LiveJob): void {
    let set = this.jobs.get(job.agentId);
    if (!set) {
      set = new Set();
      this.jobs.set(job.agentId, set);
    }
    set.add(job);
  }

  private remove(job: LiveJob): void {
    if (job.graceTimer) {
      clearTimeout(job.graceTimer);
      job.graceTimer = null;
    }
    const set = this.jobs.get(job.agentId);
    if (!set) return;
    set.delete(job);
    if (set.size === 0) this.jobs.delete(job.agentId);
  }

  /** Pi's bash tool for `agentId`, running commands through this registry.
   *  Returns null where the shell can't be wrapped (Windows, or a shell
   *  that takes the command on stdin); pi's own tool is used there. */
  createTool(
    agentId: string,
    cwd: string,
    opts: { shellPath?: string; commandPrefix?: string } = {},
  ): BashToolDefinition | null {
    if (process.platform === "win32") return null;
    let shell: ReturnType<typeof getShellConfig>;
    try {
      shell = getShellConfig(opts.shellPath);
    } catch {
      return null;
    }
    if (shell.commandTransport === "stdin") return null;

    // Only for its metadata and renderers; `execute` builds one per call.
    const base = createBashToolDefinition(cwd, {
      shellPath: opts.shellPath,
      commandPrefix: opts.commandPrefix,
    });
    const registry = this;
    return {
      ...base,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        let job: LiveJob | null = null;
        const operations: BashOperations = {
          exec: (command, execCwd, execOpts) =>
            registry.exec(
              { agentId, toolCallId, shell: { shell: shell.shell, args: shell.args } },
              command,
              execCwd,
              execOpts,
              (j) => {
                job = j;
              },
            ),
        };
        const def = createBashToolDefinition(cwd, {
          shellPath: opts.shellPath,
          commandPrefix: opts.commandPrefix,
          operations,
        });
        const result = await def.execute(toolCallId, params, signal, onUpdate, ctx);
        const j = job as LiveJob | null;
        if (!j || j.state !== "detached") return result;
        const note = detachNote(j, {
          reason: j.reason ?? "it was asked to",
          ranForMs: registry.now() - j.startedAt,
          watchId: j.adopted?.watchId ?? null,
        });
        const content = [...result.content];
        const last = content.length - 1;
        if (last >= 0 && content[last].type === "text") {
          const prev = content[last] as { type: "text"; text: string };
          content[last] = { ...prev, text: `${prev.text}\n\n${note}` };
        } else {
          content.push({ type: "text", text: note });
        }
        return { ...result, content };
      },
    };
  }

  /** `BashOperations.exec`, plus detaching. Mirrors pi's local shell
   *  operations: same errors for abort ("aborted") and timeout
   *  ("timeout:<s>"), which pi's tool turns into its usual messages. */
  private async exec(
    meta: { agentId: string; toolCallId: string; shell: { shell: string; args: string[] } },
    command: string,
    cwd: string,
    opts: Parameters<BashOperations["exec"]>[2],
    onJob: (job: LiveJob) => void,
  ): Promise<{ exitCode: number | null }> {
    const { onData, signal, timeout, env } = opts;
    if (signal?.aborted) throw new Error("aborted");
    let timeoutMs: number | undefined;
    if (timeout !== undefined) {
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error("Invalid timeout: must be a finite number of seconds");
      }
      timeoutMs = timeout * 1000;
    }
    try {
      await access(cwd, constants.F_OK);
    } catch {
      throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
    }

    mkdirSync(this.opts.jobDir, { recursive: true });
    const stem = `${safeName(meta.agentId)}-${safeName(meta.toolCallId)}-${this.now()}`;
    const logPath = path.join(this.opts.jobDir, `${stem}.log`);
    const exitPath = path.join(this.opts.jobDir, `${stem}.exit`);
    const writeFd = openSync(logPath, "w");
    let child: ChildProcess;
    try {
      child = spawn(
        "/bin/sh",
        ["-c", WRAPPER, "pru-bash", exitPath, meta.shell.shell, ...meta.shell.args, command],
        { cwd, env, detached: true, stdio: ["ignore", writeFd, writeFd] },
      );
    } finally {
      closeSync(writeFd);
    }
    const readFd = openSync(logPath, "r");
    let readFdOpen = true;
    const buf = Buffer.alloc(64 * 1024);
    const drain = () => {
      if (!readFdOpen) return;
      for (;;) {
        let n: number;
        try {
          n = readSync(readFd, buf, 0, buf.length, null);
        } catch {
          return;
        }
        if (n <= 0) return;
        onData(Buffer.from(buf.subarray(0, n)));
      }
    };
    const closeRead = () => {
      if (!readFdOpen) return;
      readFdOpen = false;
      try {
        closeSync(readFd);
      } catch {
        // ignore
      }
    };
    const removeFiles = () => {
      rmSync(logPath, { force: true });
      rmSync(exitPath, { force: true });
    };

    return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const tail = setInterval(drain, TAIL_INTERVAL_MS);
      tail.unref?.();

      const cleanup = () => {
        clearInterval(tail);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const job: LiveJob = {
        agentId: meta.agentId,
        toolCallId: meta.toolCallId,
        command,
        cwd,
        pid: child.pid ?? 0,
        startedAt: this.now(),
        logPath,
        exitPath,
        child,
        state: "attached",
        reason: null,
        adopted: null,
        graceTimer: null,
        release: () => {
          // Detached: hand back what it printed so far and stop reading.
          // The process, its log and its exit file now belong to the watch.
          drain();
          closeRead();
          this.remove(job);
          settle(() => resolve({ exitCode: 0 }));
        },
      };

      function onAbort() {
        if (job.state === "attached" && child.pid) killGroup(child.pid);
      }

      child.on("error", (err) => {
        if (job.state !== "attached") return;
        job.state = "done";
        this.remove(job);
        drain();
        closeRead();
        removeFiles();
        settle(() => reject(err));
      });

      child.on("exit", (code, sig) => {
        if (job.state !== "attached") return;
        job.state = "done";
        this.remove(job);
        drain();
        closeRead();
        removeFiles();
        settle(() => {
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code ?? (sig ? null : 0) });
        });
      });

      if (!child.pid) return; // "error" follows
      this.add(job);
      onJob(job);

      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          if (job.state !== "attached") return;
          timedOut = true;
          killGroup(child.pid!);
        }, timeoutMs);
      }
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}
