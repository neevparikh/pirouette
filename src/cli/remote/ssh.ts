/** SSH / scp helpers for talking to a pirouette host.
 *
 *  Every target is an alias in the user's `~/.ssh/config` (byo-host model):
 *  we run `ssh <alias>` and let the alias own identity, user, port, and any
 *  keepalive/ControlMaster settings. We deliberately don't pass `-i`/`-p`/
 *  `-o User=` overrides so we never shadow the user's config.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export interface RemoteTarget {
  /** `Host` alias from `~/.ssh/config`. */
  host: string;
  /** SSH login user (informational; the alias governs the actual user). */
  user?: string;
}

/** Run a remote command via SSH and capture output. Throws on non-zero exit.
 *  Agent forwarding, identity, etc. come from the alias's `~/.ssh/config`. */
export async function ssh(
  command: string,
  opts: { target: RemoteTarget; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  const args = [opts.target.host, command];
  const { stdout, stderr } = await pExecFile("ssh", args, {
    timeout: opts.timeoutMs ?? 5 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/** Run an SSH command and stream stdout/stderr to the parent's stdio live.
 *  Resolves with 0 on success, rejects on non-zero exit. No output captured.
 *
 *  Used for long/interactive remote commands where the user needs to see
 *  output as it happens (e.g. `tailscale up` printing a login URL, or slow
 *  bootstrap steps that look hung when buffered). */
export function sshStreaming(
  command: string,
  opts: { target: RemoteTarget; timeoutMs?: number },
): Promise<number> {
  const args = [opts.target.host, command];
  return new Promise<number>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
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

/** Copy a local file to the remote via scp. */
export async function scp(
  localPath: string,
  remotePath: string,
  opts: { target: RemoteTarget },
): Promise<void> {
  const args = [localPath, `${opts.target.host}:${remotePath}`];
  await pExecFile("scp", args, { timeout: 5 * 60 * 1000 });
}

/** Send a control command to a host's ControlMaster connection. Returns
 *  `ok: false` (never throws) so callers can fall back gracefully. Used by
 *  `pru tunnel` to add/remove port-forwards over an existing master.
 *
 *  Extra args go after the action, e.g. `["-L", "42103:localhost:42103"]`. */
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
