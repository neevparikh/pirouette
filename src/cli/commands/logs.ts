/** `pru logs` — tail pirouette server logs from the remote container.
 *
 *  Several sources available:
 *    --server   (default)  tail /data/logs/pirouette.log (pirouette server stdout)
 *    --tmux                capture the live tmux pane (latest state, no history)
 *    --entrypoint          entrypoint startup log (yadm, npm install, sshd launch)
 *    --boot                EC2 cloud-init output (user-data bootstrap)
 *
 *  Use `-f` / `--follow` to stream. Implemented by tailing over SSH.
 */

import { spawn } from "node:child_process";

import { containerHome, getConfig } from "../../config.js";

export interface LogsOptions {
  follow?: boolean;
  lines?: string;
  tmux?: boolean;
  entrypoint?: boolean;
  boot?: boolean;
}

/** Validate `--lines` and return a canonical integer string. We pass
 *  this through `ssh ... <command>` which goes through a remote shell,
 *  so an unsanitized value like `200; rm -rf ~` would inject the
 *  trailing command. Self-RCE only — still cheap to prevent. */
function validateLines(raw: string | undefined): string {
  const n = Number(raw ?? "200");
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) {
    throw new Error(`--lines must be a positive integer up to 100000 (got: ${raw})`);
  }
  return String(Math.floor(n));
}

function buildRemoteCommand(opts: LogsOptions, cfg: ReturnType<typeof getConfig>): string {
  const lines = validateLines(opts.lines);
  const follow = opts.follow ? "-f" : "";
  const entrypointLog = `${containerHome(cfg)}/logs/entrypoint.log`;

  if (opts.boot) {
    return `sudo tail -n ${lines} ${follow} /var/log/cloud-init-output.log`;
  }
  if (opts.entrypoint) {
    return `docker exec pirouette tail -n ${lines} ${follow} ${entrypointLog} 2>/dev/null || echo '(entrypoint log not ready yet)'`;
  }
  if (opts.tmux) {
    // tmux capture-pane is a snapshot, not a stream. Print once.
    return `docker exec pirouette tmux capture-pane -p -S -${lines} -t pirouette 2>/dev/null || echo '(pirouette tmux session not running)'`;
  }
  // Default: the pirouette server's log file. Exists as soon as the server
  // writes anything; if not ready yet we fall back to the entrypoint log.
  const log = "/var/lib/pirouette/logs/pirouette.log";
  return `[ -f ${log} ] && tail -n ${lines} ${follow} ${log} || (echo '(pirouette.log not ready; showing entrypoint log)' && docker exec pirouette tail -n ${lines} ${follow} ${entrypointLog})`;
}

export async function logs(opts: LogsOptions): Promise<void> {
  const cfg = getConfig();
  const remoteCmd = buildRemoteCommand(opts, cfg);

  const child = spawn("ssh", ["-t", cfg.ssh.host_alias, remoteCmd], { stdio: "inherit" });
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
}
