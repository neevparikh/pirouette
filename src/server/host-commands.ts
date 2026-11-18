/** Host commands: shell commands the dashboard can run on the host.
 *
 *  For maintenance that has to work when no agent can — most often
 *  renewing a login the agents' model provider depends on. An agent can't
 *  run the login for you once its own model calls are failing, so the
 *  dashboard needs a way to start it that doesn't go through a model.
 *
 *  The commands come only from the host's config file:
 *
 *      [[defaults.host_commands]]
 *      name = "provider login"
 *      command = "my-cli login"
 *      description = "Renew the login agents use for model calls"
 *      timeout_seconds = 300
 *
 *  The API takes a command's id, never a command line, so the dashboard
 *  can run exactly what the host's owner listed and nothing else.
 *
 *  Each command runs under `/bin/sh -c` in the server's environment with
 *  stdin closed, at most one run of each at a time. Output (stdout and
 *  stderr interleaved) is kept in memory for the dashboard to poll; it is
 *  not persisted. `BROWSER` defaults to `echo`, so a tool that tries to
 *  open a browser prints the URL instead, and the dashboard turns URLs in
 *  the output into links. `PIROUETTE_HOST_COMMAND` holds the command's id
 *  so a script can tell it was started from the dashboard.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

/** One `[[defaults.host_commands]]` entry as written in TOML. */
export interface HostCommandConfig {
  name?: unknown;
  command?: unknown;
  description?: unknown;
  timeout_seconds?: unknown;
}

export interface HostCommand {
  /** URL-safe id derived from the name. */
  id: string;
  name: string;
  command: string;
  description: string;
  timeoutMs: number;
}

export const DEFAULT_TIMEOUT_SECONDS = 600;
/** Output kept per command; older output is dropped first. */
export const MAX_OUTPUT_CHARS = 64 * 1024;
/** Grace between SIGTERM and SIGKILL when stopping a command. */
const KILL_GRACE_MS = 3000;

export function hostCommandId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Validate `[[defaults.host_commands]]`. Bad entries are skipped with a
 *  warning rather than failing server start. */
export function resolveHostCommands(raw: unknown): { commands: HostCommand[]; warnings: string[] } {
  const commands: HostCommand[] = [];
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { commands, warnings };
  if (!Array.isArray(raw)) {
    warnings.push("ignoring host_commands: expected an array of tables ([[defaults.host_commands]])");
    return { commands, warnings };
  }
  const seen = new Set<string>();
  raw.forEach((entry: HostCommandConfig, i) => {
    const where = `host_commands[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      warnings.push(`ignoring ${where}: expected a table`);
      return;
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    if (!name || !command) {
      warnings.push(`ignoring ${where}: needs a non-empty name and command`);
      return;
    }
    const id = hostCommandId(name);
    if (!id) {
      warnings.push(`ignoring ${where}: name ${JSON.stringify(name)} has no letters or digits`);
      return;
    }
    if (seen.has(id)) {
      warnings.push(`ignoring ${where}: name ${JSON.stringify(name)} duplicates an earlier command`);
      return;
    }
    let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
    if (entry.timeout_seconds !== undefined) {
      const t = entry.timeout_seconds;
      if (typeof t === "number" && Number.isFinite(t) && t > 0) {
        timeoutSeconds = t;
      } else {
        warnings.push(
          `ignoring ${where}.timeout_seconds=${JSON.stringify(t)}: expected a positive number of seconds`,
        );
      }
    }
    seen.add(id);
    commands.push({
      id,
      name,
      command,
      description: typeof entry.description === "string" ? entry.description.trim() : "",
      timeoutMs: timeoutSeconds * 1000,
    });
  });
  return { commands, warnings };
}

export type HostCommandState = "idle" | "running" | "exited";

/** What the API returns for a command. The command line itself is shown
 *  so the user can see what a button will run. */
export interface HostCommandStatus {
  id: string;
  name: string;
  command: string;
  description: string;
  state: HostCommandState;
  startedAt?: number;
  finishedAt?: number;
  /** Exit code of the last run; null when a signal ended it. */
  exitCode?: number | null;
  /** True when the last run was ended by its timeout. */
  timedOut?: boolean;
  /** True when the last run was ended by a stop request. */
  stopped?: boolean;
  /** Present only when asked for (see `HostCommandRunner.get`). */
  output?: string;
  /** True when the start of the output was dropped to stay under the cap. */
  outputTruncated?: boolean;
}

interface Run {
  state: HostCommandState;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  timedOut: boolean;
  stopped: boolean;
  output: string;
  outputTruncated: boolean;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
}

export interface HostCommandRunnerOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  maxOutputChars?: number;
}

export class HostCommandRunner {
  private readonly commands: Map<string, HostCommand>;
  private readonly runs = new Map<string, Run>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly maxOutputChars: number;

  constructor(commands: HostCommand[], opts: HostCommandRunnerOptions = {}) {
    this.commands = new Map(commands.map((c) => [c.id, c]));
    this.env = opts.env ?? process.env;
    this.cwd = opts.cwd ?? homedir();
    this.maxOutputChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  }

  list(): HostCommandStatus[] {
    return [...this.commands.keys()].map((id) => this.status(id, false));
  }

  /** Status including output, or undefined for an unknown id. */
  get(id: string): HostCommandStatus | undefined {
    return this.commands.has(id) ? this.status(id, true) : undefined;
  }

  /** Start a run. Returns "unknown" for an id that isn't configured and
   *  "running" when that command is already running. */
  start(id: string): HostCommandStatus | "unknown" | "running" {
    const command = this.commands.get(id);
    if (!command) return "unknown";
    if (this.runs.get(id)?.state === "running") return "running";

    const run: Run = {
      state: "running",
      startedAt: Date.now(),
      timedOut: false,
      stopped: false,
      output: "",
      outputTruncated: false,
    };
    this.runs.set(id, run);

    const append = (chunk: string): void => {
      run.output += chunk;
      if (run.output.length > this.maxOutputChars) {
        run.output = run.output.slice(run.output.length - this.maxOutputChars);
        run.outputTruncated = true;
      }
    };
    const finish = (exitCode: number | null): void => {
      if (run.state !== "running") return;
      run.state = "exited";
      run.finishedAt = Date.now();
      run.exitCode = exitCode;
      run.child = undefined;
      if (run.timer) clearTimeout(run.timer);
    };

    // Own process group, so stopping it also stops what it started.
    const child = spawn("/bin/sh", ["-c", command.command], {
      cwd: this.cwd,
      env: { ...this.env, BROWSER: this.env.BROWSER || "echo", PIROUETTE_HOST_COMMAND: id },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    run.child = child;
    child.stdout?.setEncoding("utf8").on("data", append);
    child.stderr?.setEncoding("utf8").on("data", append);
    child.on("error", (err) => {
      append(`could not start: ${err.message}\n`);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    run.timer = setTimeout(() => {
      run.timedOut = true;
      append(`\ntimed out after ${Math.round(command.timeoutMs / 1000)}s\n`);
      this.kill(run);
    }, command.timeoutMs);
    run.timer.unref();

    return this.status(id, true);
  }

  /** Stop a running command. False when it isn't running. */
  stop(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.state !== "running") return false;
    run.stopped = true;
    this.kill(run);
    return true;
  }

  /** Stop everything; called on server shutdown. */
  stopAll(): void {
    for (const id of this.runs.keys()) this.stop(id);
  }

  private kill(run: Run): void {
    const pid = run.child?.pid;
    if (pid === undefined) return;
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig);
      } catch {
        // Already gone.
      }
    };
    signal("SIGTERM");
    setTimeout(() => {
      if (run.state === "running") signal("SIGKILL");
    }, KILL_GRACE_MS).unref();
  }

  private status(id: string, withOutput: boolean): HostCommandStatus {
    const command = this.commands.get(id)!;
    const run = this.runs.get(id);
    const status: HostCommandStatus = {
      id,
      name: command.name,
      command: command.command,
      description: command.description,
      state: run?.state ?? "idle",
    };
    if (run) {
      status.startedAt = run.startedAt;
      if (run.state === "exited") {
        status.finishedAt = run.finishedAt;
        status.exitCode = run.exitCode ?? null;
        status.timedOut = run.timedOut;
        status.stopped = run.stopped;
      }
      if (withOutput) {
        status.output = run.output;
        status.outputTruncated = run.outputTruncated;
      }
    } else if (withOutput) {
      status.output = "";
      status.outputTruncated = false;
    }
    return status;
  }
}
