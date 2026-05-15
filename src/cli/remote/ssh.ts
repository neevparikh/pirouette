/** SSH / rsync helpers bound to the pirouette remote instance.
 *
 *  All commands target the private IP stored in `~/.pirouette/ec2.json`.
 *  Assumes the caller's laptop is on Tailscale (or otherwise has L3 reach
 *  to the instance's VPC subnet).
 */

import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expandHome, getConfig, type PirouetteConfig } from "../../config.js";
import { loadRemoteState, type RemoteState } from "./state.js";

const pExecFile = promisify(execFile);

/** Directory holding ControlMaster sockets. Created mode 700 so other users
 *  on the laptop can't impersonate our SSH master. */
export const SSH_CONTROL_DIR = path.join(homedir(), ".pirouette", "ssh-control");

function ensureControlDir(): void {
  if (!existsSync(SSH_CONTROL_DIR)) {
    mkdirSync(SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });
  }
}

/** Shared SSH options used for every command targeting a literal host
 *  (EC2 private IP, etc.). Disables host-key prompts on first connect
 *  (the instance is freshly booted and has no known host fp); keeps a
 *  short ServerAlive so dropped tailnet connections surface quickly.
 *  ControlMaster multiplexing amortises TCP setup across multiple calls. */
function sshOptions(keyPath: string): string[] {
  return [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=" + path.join(homedir(), ".ssh", "known_hosts"),
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-i", keyPath,
  ];
}

/** Build the destination + option args list for a target. Two shapes:
 *   - literal host: returns `[...sshOptions(keyPath), user@host]` so we
 *     fully specify identity / known-hosts / keepalives.
 *   - alias (byo-host): returns `[alias]` only. The user's ssh_config
 *     owns identity, user, port, and any keepalive settings; we deliberately
 *     don't pass our defaults so we don't shadow theirs. The same applies
 *     to scp: `[alias:path]` only. */
function targetArgs(t: RemoteTarget): { opts: string[]; dest: string } {
  if (t.useAlias) {
    return { opts: [], dest: t.host };
  }
  return { opts: sshOptions(t.keyPath!), dest: `${t.user}@${t.host}` };
}

export interface RemoteTarget {
  user: string;
  /** Literal host (IP / hostname) when `useAlias` is false, otherwise a
   *  `Host` alias from `~/.ssh/config`. */
  host: string;
  /** Identity file. Required when `useAlias` is false; ignored otherwise
   *  (the alias handles its own identity). */
  keyPath?: string;
  /** Custom port. Ignored when `useAlias` is true. */
  port?: number;
  /** If true, `host` is an ssh_config alias and we skip our default
   *  options so the user's ssh_config wins. Used by byo-host. */
  useAlias?: boolean;
}

/** Resolve the remote target from config + state; throw if there's no
 *  instance yet. */
export function currentTarget(
  cfg: PirouetteConfig = getConfig(),
  state: RemoteState = loadRemoteState(),
): RemoteTarget {
  if (!state.privateIp) {
    throw new Error("No remote instance configured. Run `pru setup` first.");
  }
  return {
    user: cfg.ssh.user,
    host: state.privateIp,
    keyPath: expandHome(cfg.ssh.private_key),
  };
}

/** Run a remote command via SSH and capture output. Throws on non-zero exit.
 *  Use `ssh(command, { stdio: "inherit" })` for interactive shells. */
export async function ssh(
  command: string,
  opts: {
    target?: RemoteTarget;
    timeoutMs?: number;
    /** Forward the SSH agent (for git operations). */
    forwardAgent?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const t = opts.target ?? currentTarget();
  const { opts: sshOpts, dest } = targetArgs(t);
  const args = [
    ...sshOpts,
    ...(opts.forwardAgent ? ["-A"] : []),
    dest,
    command,
  ];
  const { stdout, stderr } = await pExecFile("ssh", args, {
    timeout: opts.timeoutMs ?? 5 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/** Run an SSH command and stream stdout/stderr to the parent's stdio in
 *  real time. Returns the exit code. No output is captured/returned.
 *
 *  Use this for long-running remote commands where the user needs to see
 *  output as it happens — typically because the remote command is
 *  interactive (e.g. `tailscale up` printing a login URL and blocking
 *  until the user approves in a browser) or slow enough that buffered
 *  output makes pirouette look hung.
 *
 *  Unlike `ssh()`, this does NOT capture stdout/stderr; you can't read
 *  what was printed. If you need both, prefer two roundtrips (one
 *  streaming, one buffered probe) over try-to-have-both. */
export function sshStreaming(
  command: string,
  opts: {
    target?: RemoteTarget;
    forwardAgent?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<number> {
  const t = opts.target ?? currentTarget();
  const { opts: sshOpts, dest } = targetArgs(t);
  const args = [
    ...sshOpts,
    ...(opts.forwardAgent ? ["-A"] : []),
    dest,
    command,
  ];
  return new Promise<number>((resolve, reject) => {
    // Don't allocate a tty (-t) -- we want the remote stdout to be a
    // pipe so tailscale up's login URL prints unbuffered. Streaming
    // happens because `stdio: "inherit"` connects the child's pipes
    // directly to the parent's terminal.
    const child = spawn("ssh", args, { stdio: "inherit" });
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    }
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(0);
      else reject(new Error(`ssh exited with code ${code ?? "null"}`));
    });
  });
}

/** Run an interactive SSH session (stdio inherited, terminal passed through). */
export function sshInteractive(
  remoteCommand: string | null = null,
  opts: { target?: RemoteTarget; forwardAgent?: boolean } = {},
): Promise<number> {
  const t = opts.target ?? currentTarget();
  const { opts: sshOpts, dest } = targetArgs(t);
  const args = [
    ...sshOpts,
    "-t",
    ...(opts.forwardAgent ? ["-A"] : []),
    dest,
  ];
  if (remoteCommand) args.push(remoteCommand);
  return new Promise<number>((resolve) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

/** Copy a local file to the remote instance via scp. */
export async function scp(
  localPath: string,
  remotePath: string,
  opts: { target?: RemoteTarget } = {},
): Promise<void> {
  const t = opts.target ?? currentTarget();
  const { opts: sshOpts, dest } = targetArgs(t);
  const args = [
    ...sshOpts,
    localPath,
    `${dest}:${remotePath}`,
  ];
  await pExecFile("scp", args, { timeout: 5 * 60 * 1000 });
}

/** Rsync a local directory to the remote. Pass `excludes: [".git"]` etc. */
export async function rsync(
  localDir: string,
  remoteDir: string,
  opts: {
    target?: RemoteTarget;
    excludes?: string[];
    /** Delete files on the remote not present locally. Default false. */
    deleteExtraneous?: boolean;
  } = {},
): Promise<void> {
  const t = opts.target ?? currentTarget();
  const { opts: sshOpts, dest } = targetArgs(t);
  // rsync needs the inner ssh command as a single string. Build it the
  // same way as the ssh() function above: option flags + nothing else.
  const sshCmd = ["ssh", ...sshOpts].join(" ");
  const args = ["-az", "--info=stats1", "-e", sshCmd];
  for (const e of opts.excludes ?? []) args.push("--exclude", e);
  if (opts.deleteExtraneous) args.push("--delete");
  // Trailing / on src means "contents of", not the dir itself
  const local = localDir.endsWith("/") ? localDir : localDir + "/";
  args.push(local, `${dest}:${remoteDir}`);
  await pExecFile("rsync", args, { timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
}

/** Poll the instance until we can open an SSH session, or timeout.
 *  Returns when we get a successful `echo ok` round-trip. */
export async function waitForSsh(
  target: RemoteTarget,
  opts: { timeoutMs?: number; pollIntervalMs?: number; onAttempt?: (i: number) => void } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 4 * 60 * 1000);
  const interval = opts.pollIntervalMs ?? 5000;
  let attempt = 0;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    attempt++;
    opts.onAttempt?.(attempt);
    try {
      const { stdout } = await ssh("echo ok", {
        target,
        timeoutMs: Math.min(10_000, deadline - Date.now()),
      });
      if (stdout.trim() === "ok") return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "timeout");
  throw new Error(`SSH to ${target.host} never came up: ${msg}`);
}

// ---- ~/.ssh/config management --------------------------------------------

const SSH_CONFIG_BEGIN = "# >>> pirouette managed block >>>";
const SSH_CONFIG_END = "# <<< pirouette managed block <<<";

export interface SshConfigEntry {
  alias: string;
  hostName: string;
  user: string;
  port?: number;
  keyPath?: string;
  /** Optional ProxyJump target (another Host alias). Used for jumping into
   *  the container through the EC2 host. */
  proxyJump?: string;
  /** Optional RemoteForward directives, like ["/var/.../ssh.sock", "${SSH_AUTH_SOCK}"]. */
  remoteForwards?: Array<{ remote: string; local: string }>;
}

/** Add or replace the pirouette-managed SSH config block. Idempotent:
 *  a single contiguous block is rewritten each time — never duplicates.
 *  Multiple entries can be passed so we can add both `pirouette` (host)
 *  and `pirouette-container` (container-via-jump) in one call.
 *
 *  Every entry gets ControlMaster directives so subsequent ssh calls reuse
 *  a single TCP connection (huge for `pirouette-container`, which otherwise
 *  re-does ProxyJump every time). */
export function upsertSshConfig(entries: SshConfigEntry[]): void {
  ensureControlDir();
  const sshConfigPath = path.join(homedir(), ".ssh", "config");
  const existing = existsSync(sshConfigPath) ? readFileSync(sshConfigPath, "utf8") : "";

  const lines: string[] = [SSH_CONFIG_BEGIN];
  for (const e of entries) {
    lines.push(`Host ${e.alias}`);
    lines.push(`  HostName ${e.hostName}`);
    lines.push(`  User ${e.user}`);
    lines.push(`  Port ${e.port ?? 22}`);
    if (e.keyPath) lines.push(`  IdentityFile ${e.keyPath}`);
    if (e.proxyJump) lines.push(`  ProxyJump ${e.proxyJump}`);
    lines.push(`  ForwardAgent yes`);
    lines.push(`  StrictHostKeyChecking accept-new`);
    lines.push(`  ServerAliveInterval 30`);
    lines.push(`  ServerAliveCountMax 3`);
    // ControlMaster: any ssh becomes the master if no socket exists; keep
    // the master alive 10 minutes after the last channel closes. %C is a
    // hash of host+user+port so different aliases get distinct sockets.
    lines.push(`  ControlMaster auto`);
    lines.push(`  ControlPath ${SSH_CONTROL_DIR}/%C`);
    lines.push(`  ControlPersist 10m`);
    for (const rf of e.remoteForwards ?? []) {
      lines.push(`  RemoteForward ${rf.remote} ${rf.local}`);
    }
    lines.push("");
  }
  lines.push(SSH_CONFIG_END);
  lines.push("");
  const block = lines.join("\n");

  const beginRe = new RegExp(
    `(^|\\n)${escapeRegex(SSH_CONFIG_BEGIN)}[\\s\\S]*?${escapeRegex(SSH_CONFIG_END)}\\n?`,
    "g",
  );
  let next: string;
  if (beginRe.test(existing)) {
    next = existing.replace(beginRe, "\n" + block);
  } else {
    next = existing + (existing.endsWith("\n") || existing === "" ? "" : "\n") + "\n" + block;
  }
  writeFileSync(sshConfigPath, next);
}

/** Remove the pirouette-managed SSH config block entirely. Used by teardown/destroy. */
export function removeSshConfig(): void {
  const sshConfigPath = path.join(homedir(), ".ssh", "config");
  if (!existsSync(sshConfigPath)) return;
  const existing = readFileSync(sshConfigPath, "utf8");
  const beginRe = new RegExp(
    `\\n?${escapeRegex(SSH_CONFIG_BEGIN)}[\\s\\S]*?${escapeRegex(SSH_CONFIG_END)}\\n?`,
    "g",
  );
  writeFileSync(sshConfigPath, existing.replace(beginRe, "\n"));
}

// ---- ControlMaster helpers ------------------------------------------------

/** Send a control command to a host's master connection. Returns true if the
 *  master responded successfully, false otherwise. Used to:
 *  - check liveness (`check`)
 *  - add forwards (`forward`)
 *  - remove forwards (`cancel`)
 *  - tear down master (`exit`)
 *
 *  Extra args go after the action: e.g. `["-L", "42103:localhost:42103"]`.
 *
 *  Doesn't throw on failure — returns false. Most callers want graceful
 *  fallback (e.g. "if check fails, just open a fresh ssh"). */
export async function sshControl(
  hostAlias: string,
  action: "check" | "forward" | "cancel" | "exit" | "stop",
  extraArgs: string[] = [],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const args = ["-O", action, ...extraArgs, hostAlias];
  try {
    const { stdout, stderr } = await pExecFile("ssh", args, { timeout: 10_000 });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
  }
}

/** Tear down any live ControlMaster connections (for the given aliases) and
 *  remove their socket files. Best-effort — a stale socket left behind is
 *  harmless because OpenSSH will overwrite on next master open. */
export function killControlMasters(aliases: string[]): void {
  // Tell each master to exit gracefully. We can't await here because this is
  // called from sync teardown paths; spawn is fine since it's best-effort.
  for (const alias of aliases) {
    spawn("ssh", ["-O", "exit", alias], { stdio: "ignore" }).on("error", () => {});
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Append an entry to `~/.ssh/known_hosts` so we don't get the "authenticity"
 *  prompt on first connect. Called after waitForSsh succeeds (meaning the
 *  accept-new option already captured the key). No-op if the host has a
 *  known-hosts entry already. */
export function ensureKnownHostsEntry(privateIp: string): void {
  const knownHosts = path.join(homedir(), ".ssh", "known_hosts");
  const lines = existsSync(knownHosts) ? readFileSync(knownHosts, "utf8") : "";
  if (lines.includes(privateIp)) return;
  // Best-effort append via ssh-keyscan — tolerable if it fails; the
  // StrictHostKeyChecking=accept-new in sshOptions catches us anyway.
  try {
    const result = spawnKeyScan(privateIp);
    if (result) appendFileSync(knownHosts, result);
  } catch {
    // ignore
  }
}

function spawnKeyScan(host: string): string | null {
  try {
    // Using execFileSync would be cleaner but we imported execFile async above;
    // inline a sync spawn for this one-off so we don't need another import.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("ssh-keyscan", ["-H", host], { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return null;
  }
}
