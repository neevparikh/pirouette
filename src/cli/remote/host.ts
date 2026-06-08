/** Host — the single runtime model: pirouette runs on an SSH-reachable host
 *  the user already manages (a METR devpod, a long-running VM, a dev
 *  container, ...). Pirouette doesn't own the host's lifecycle; it SSHes in,
 *  runs a bootstrap script (install + tmux server, optionally a persistent-
 *  home migration), and manages the pirouette server from there.
 *
 *  `getHost(name?)` resolves the targeted host from config (honouring the
 *  global `--host` flag) and returns a `Host` bound to its effective config.
 *
 *  The bootstrap script lives at `scripts/pirouette-bootstrap.sh`.
 */

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getConfig,
  resolveHost,
  selectHostName,
  type EffectiveHostConfig,
  type PirouetteConfig,
} from "../../config.js";
import { checkLocalAuth, pushSecrets as pushSecretsLib } from "./secrets.js";
import { scp as runScp, ssh as runSsh, sshStreaming, type RemoteTarget } from "./ssh.js";
import {
  clearHostState,
  hasHostState,
  loadHostState,
  updateHostState,
} from "./state.js";

/** Options for `pru logs`. */
export interface LogsOptions {
  follow?: boolean;
  lines?: string;
  tmux?: boolean;
  entrypoint?: boolean;
}

/** Output of `buildLogsCommand`: a remote command + the ssh alias to run it on. */
export interface LogsCommand {
  command: string;
  sshAlias: string;
}

/** Where the bootstrap script lands on the remote. /tmp is fine — re-uploaded
 *  on every setup/sync. */
const REMOTE_BOOTSTRAP_PATH = "/tmp/pirouette-bootstrap.sh";

function remoteTarballsDir(persistentRoot: string): string {
  return `${persistentRoot}/pirouette/tarballs`;
}

/** Resolve `scripts/pirouette-bootstrap.sh` in both dev and built layouts. */
function bootstrapScriptPath(): string {
  const here = fileURLToPath(import.meta.url);
  // src/cli/remote/host.ts → 3 dirs up → repo root → /scripts/
  // dist/cli/remote/host.js → 3 dirs up → package root → /scripts/
  return path.resolve(path.dirname(here), "..", "..", "..", "scripts", "pirouette-bootstrap.sh");
}

/** Env the bootstrap script reads. Keep in lock-step with
 *  `scripts/pirouette-bootstrap.sh`. */
export interface BootstrapEnv {
  PIROUETTE_PERSISTENT_ROOT: string;
  PIROUETTE_HOME_DIR: string;
  PIROUETTE_DATA_DIR: string;
  PIROUETTE_PACKAGE: string;
  PIROUETTE_PORT: string;
  /** Bind address for the server (127.0.0.1 default; 0.0.0.0 for containers). */
  PIROUETTE_BIND_HOST: string;
  /** "1" → skip the persistent-home migration (already-set-up hosts). */
  PIROUETTE_ADOPT?: string;
  PIROUETTE_DOTFILES_URL?: string;
  PIROUETTE_AUTHORIZED_KEYS_URL?: string;
  PIROUETTE_DEFAULT_MODEL?: string;
  PIROUETTE_DEFAULT_THINKING_LEVEL?: string;
  PIROUETTE_ALLOWED_HOSTS?: string;
  PIROUETTE_TS_ENABLED?: string;
  PIROUETTE_TS_HOSTNAME?: string;
  PIROUETTE_TS_STATE_PERSISTENT?: string;
}

/** Map an effective host config to the env the bootstrap script reads. Pure
 *  (no I/O) so it can be unit-tested against the script's contract. Empty /
 *  false-y optional values are omitted rather than passed as empty strings,
 *  so the script's own defaults apply. */
export function buildBootstrapEnv(c: EffectiveHostConfig): BootstrapEnv {
  const env: BootstrapEnv = {
    PIROUETTE_PERSISTENT_ROOT: c.persistent_root,
    PIROUETTE_HOME_DIR: c.home_dir,
    PIROUETTE_DATA_DIR: c.data_dir,
    PIROUETTE_PACKAGE: c.npm_package,
    PIROUETTE_PORT: String(c.port),
    PIROUETTE_BIND_HOST: c.bind_host,
  };
  if (c.adopt) env.PIROUETTE_ADOPT = "1";
  if (c.dotfiles.clone_url) env.PIROUETTE_DOTFILES_URL = c.dotfiles.clone_url;
  if (c.dotfiles.authorized_keys_url) {
    env.PIROUETTE_AUTHORIZED_KEYS_URL = c.dotfiles.authorized_keys_url;
  }
  if (c.default_model) env.PIROUETTE_DEFAULT_MODEL = c.default_model;
  if (c.default_thinking_level) env.PIROUETTE_DEFAULT_THINKING_LEVEL = c.default_thinking_level;
  if (c.allowed_hosts.length > 0) env.PIROUETTE_ALLOWED_HOSTS = c.allowed_hosts.join(",");
  if (c.tailscale.enabled) {
    env.PIROUETTE_TS_ENABLED = "1";
    env.PIROUETTE_TS_HOSTNAME = c.tailscale.hostname;
    env.PIROUETTE_TS_STATE_PERSISTENT = c.tailscale.state_persistent ? "1" : "0";
  }
  return env;
}

export class Host {
  constructor(public readonly cfg: EffectiveHostConfig) {}

  get name(): string {
    return this.cfg.name;
  }

  private target(): RemoteTarget {
    return { host: this.cfg.ssh_alias, user: this.cfg.user };
  }

  // ---- preflight --------------------------------------------------------

  async preflight(): Promise<void> {
    const c = this.cfg;

    try {
      execFileSync("ssh", ["-G", c.ssh_alias], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      throw new Error(
        `ssh alias "${c.ssh_alias}" is not configured in ~/.ssh/config.\n` +
          `Add a Host block for it, or fix hosts.${c.name}.ssh_alias.\n` +
          `Underlying error: ${err instanceof Error ? err.message : err}`,
      );
    }

    console.log(`probing ssh: ${c.ssh_alias} ...`);
    const { stdout } = await runSsh("echo ok", { target: this.target(), timeoutMs: 15_000 });
    if (stdout.trim() !== "ok") {
      throw new Error(`unexpected SSH probe response: ${JSON.stringify(stdout)}`);
    }
    console.log(`  ok (logged in as ${c.user}@${c.ssh_alias})`);

    // A host that's adopted (already set up the way the user wants) but left
    // on the default loopback bind is almost always a mistake for the
    // container case: something in front of the bind (docker -p, a host-level
    // `tailscale serve`) won't be able to reach a 127.0.0.1-bound server, so
    // the dashboard silently goes dark. Warn rather than fail (there are
    // valid adopt+loopback setups, e.g. SSH-tunnel-only access).
    if (c.adopt && c.bind_host === "127.0.0.1") {
      console.log("");
      console.log(
        `WARNING: hosts.${c.name} has adopt=true but bind_host=127.0.0.1. If you ` +
          `reach this host through a docker -p mapping or a host-level \`tailscale ` +
          `serve\`, set bind_host = "0.0.0.0" or the dashboard will be unreachable.`,
      );
      console.log("");
    }

    const auth = checkLocalAuth();
    if (!auth.ready) {
      console.log("");
      console.log("WARNING: " + auth.hint);
      console.log("");
    }
  }

  // ---- provision (pru setup) -------------------------------------------

  async provision(): Promise<void> {
    const c = this.cfg;

    const localScript = bootstrapScriptPath();
    console.log(`uploading bootstrap script -> ${c.ssh_alias}:${REMOTE_BOOTSTRAP_PATH}`);
    await runScp(localScript, REMOTE_BOOTSTRAP_PATH, { target: this.target() });

    const envPrefix = Object.entries(buildBootstrapEnv(c))
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(" ");

    if (c.adopt) {
      console.log(`running bootstrap in adopt mode (skips home-migration)...`);
    } else if (c.tailscale.enabled) {
      console.log(
        `running bootstrap (first run can take a few minutes; tailscale auth is ` +
          `interactive — watch for a login URL below)...`,
      );
    } else {
      console.log(`running bootstrap (first run can take a minute)...`);
    }

    // Stream live so tailscale's login URL and slow steps are visible.
    await sshStreaming(
      `chmod +x ${REMOTE_BOOTSTRAP_PATH} && ${envPrefix} bash -l ${REMOTE_BOOTSTRAP_PATH}`,
      { target: this.target(), timeoutMs: 15 * 60 * 1000 },
    );

    console.log("pushing local auth secrets...");
    const sec = await this.pushSecrets();
    if (sec.pushed === 0 && sec.missing.length > 0) {
      console.log(
        `  (none pushed; pi providers will need /login on first use. Missing: ${sec.missing.join(", ")})`,
      );
    }

    updateHostState(this.name, {
      setupAt: loadHostState(this.name).setupAt ?? new Date().toISOString(),
      sshAlias: c.ssh_alias,
      user: c.user,
      dataDir: c.data_dir,
      homeDir: c.home_dir,
    });

    console.log("waiting for pirouette server to be healthy...");
    await this.waitForServerHealthy({ timeoutMs: 3 * 60 * 1000 });

    let tsFqdn: string | null = null;
    if (c.tailscale.enabled) {
      tsFqdn = await this.readTailscaleFqdn();
    }

    console.log("");
    console.log("  setup complete.");
    if (tsFqdn) {
      console.log(`  Tailscale: https://${tsFqdn} (reachable from any tailnet device)`);
      console.log(`    set on your laptop:  export PIROUETTE_URL=https://${tsFqdn}`);
      console.log(`    or in config:        hosts.${c.name}.public_url = "https://${tsFqdn}"`);
      console.log("");
      console.log(`  Or SSH tunnel (always works):`);
      console.log(`    ssh -fN -L ${c.port}:localhost:${c.port} ${c.ssh_alias}`);
      console.log(`    export PIROUETTE_URL=http://localhost:${c.port}`);
    } else if (c.public_url) {
      console.log(`  Dashboard: ${c.public_url}`);
    } else {
      console.log(`  Open an SSH tunnel from your laptop:`);
      console.log(`    ssh -fN -L ${c.port}:localhost:${c.port} ${c.ssh_alias}`);
      console.log(`    export PIROUETTE_URL=http://localhost:${c.port}`);
    }
    console.log("");
    console.log(`  pru --host ${c.name} ssh      # shell into ${c.ssh_alias}`);
    console.log(`  pru --host ${c.name} logs     # tail server logs`);
    console.log(`  pru --host ${c.name} status   # check server health`);
  }

  // ---- stop (pru teardown) ---------------------------------------------

  async stop(): Promise<void> {
    if (!hasHostState(this.name)) {
      console.log(`host "${this.name}" has no recorded state; nothing to stop.`);
      return;
    }
    console.log(`stopping pirouette tmux session on ${this.cfg.ssh_alias}...`);
    try {
      await runSsh(`tmux kill-session -t pirouette 2>/dev/null || true`, {
        target: this.target(),
      });
      console.log("  done.");
    } catch (err) {
      console.log(`  warning: ${err instanceof Error ? err.message : err}`);
    }
    console.log(`  Host is still running; persistent state preserved. pru setup to resume.`);
  }

  // ---- destroy ----------------------------------------------------------

  async destroy(opts: { deletePersistent: boolean; yes?: boolean }): Promise<void> {
    const c = this.cfg;
    if (!hasHostState(this.name)) {
      console.log(`host "${this.name}" has no recorded state; nothing to destroy.`);
      return;
    }

    console.log("about to clean up:");
    console.log(`  local:   ~/.pirouette/state/${this.name}.json`);
    if (opts.deletePersistent) {
      console.log(`  remote:  rm -rf ${c.data_dir} ${c.home_dir}`);
      console.log(`  (pirouette doesn't own ${c.ssh_alias}; the host itself stays up)`);
    } else {
      console.log(`  remote:  nothing (pass --delete-data to nuke persistent state)`);
    }

    if (!opts.yes) {
      const sure = await confirm("proceed?");
      if (!sure) {
        console.log("cancelled.");
        return;
      }
    }

    try {
      await runSsh(`tmux kill-session -t pirouette 2>/dev/null || true`, {
        target: this.target(),
      });
    } catch {
      /* best effort */
    }

    if (opts.deletePersistent) {
      console.log(`nuking persistent dirs on ${c.ssh_alias}...`);
      const home = `/home/${c.user}`;
      // Only unlink /home/<user> if it's a symlink onto our home_dir (the
      // bootstrap's migration). Leaves bind-mounted / real homes untouched.
      await runSsh(
        `set -e; ` +
          `rm -rf ${shellQuote(c.data_dir)} ${shellQuote(c.home_dir)}; ` +
          `if [ -L ${shellQuote(home)} ] && [ "$(readlink ${shellQuote(home)})" = ${shellQuote(c.home_dir)} ]; then ` +
          `  sudo unlink ${shellQuote(home)}; ` +
          `fi`,
        { target: this.target() },
      );
      console.log("  done.");
    }

    clearHostState(this.name);
    console.log("  cleared local state.");
  }

  // ---- status -----------------------------------------------------------

  /** Lines describing the host for `pru status`. Best-effort: never throws
   *  on a transient SSH error — surfaces it as a line instead. */
  async status(): Promise<string[]> {
    const c = this.cfg;
    const lines: string[] = [
      `  host       ${this.name}`,
      `  alias      ${c.ssh_alias}`,
      `  user       ${c.user}`,
      `  home dir   ${c.home_dir}`,
    ];

    if (!hasHostState(this.name)) {
      lines.push(`  state      not set up (run \`pru --host ${this.name} setup\`)`);
      return lines;
    }

    // One round-trip: is tmux running, does the data dir exist, and the
    // tailscale FQDN (if the bootstrap wrote one).
    const probe =
      `tmux has-session -t pirouette 2>/dev/null && echo TMUX_RUNNING || echo TMUX_STOPPED; ` +
      `if [ -d ${shellQuote(c.data_dir)} ]; then echo DATA_DIR_OK; else echo DATA_DIR_MISSING; fi; ` +
      `echo TS_FQDN="$(cat ${shellQuote(c.data_dir + "/tailscale-fqdn")} 2>/dev/null || echo none)"`;
    try {
      const { stdout } = await runSsh(probe, { target: this.target(), timeoutMs: 15_000 });
      const out = stdout.trim().split("\n").map((l) => l.trim());
      const tmuxRunning = out.includes("TMUX_RUNNING");
      const dataDirOk = out.includes("DATA_DIR_OK");
      const tsLine = out.find((l) => l.startsWith("TS_FQDN="));
      const tsFqdn = tsLine ? tsLine.slice("TS_FQDN=".length) : "none";
      lines.push(`  data dir   ${dataDirOk ? "\u2705 present" : "\u26a0 missing"} (${c.data_dir})`);
      lines.push(`  tmux       ${tmuxRunning ? "\u2705 running" : "\u26a0 stopped"}`);
      if (tsFqdn !== "none" && tsFqdn !== "") {
        lines.push(`  tailscale  \u2705 https://${tsFqdn}`);
      }
    } catch (err) {
      lines.push(`  health     unreachable (${err instanceof Error ? err.message : err})`);
    }
    return lines;
  }

  // ---- ssh / logs targets ----------------------------------------------

  shellAlias(): string {
    return process.env.PIROUETTE_SSH_HOST ?? this.cfg.ssh_alias;
  }

  buildLogsCommand(opts: LogsOptions): LogsCommand {
    const c = this.cfg;
    const lines = validateLines(opts.lines);
    const follow = opts.follow ? "-f" : "";
    const pirouetteLog = `${c.data_dir}/logs/pirouette.log`;
    const bootstrapLog = `${c.home_dir}/logs/bootstrap.log`;

    let command: string;
    if (opts.entrypoint) {
      command = `tail -n ${lines} ${follow} ${bootstrapLog} 2>/dev/null || echo '(bootstrap log not ready yet)'`;
    } else if (opts.tmux) {
      command = `tmux capture-pane -p -S -${lines} -t pirouette 2>/dev/null || echo '(pirouette tmux session not running)'`;
    } else {
      command = `[ -f ${pirouetteLog} ] && tail -n ${lines} ${follow} ${pirouetteLog} || (echo '(pirouette.log not ready; showing bootstrap log)' && tail -n ${lines} ${follow} ${bootstrapLog})`;
    }
    return { command, sshAlias: c.ssh_alias };
  }

  // ---- secrets ----------------------------------------------------------

  async pushSecrets(): Promise<{ pushed: number; skipped: number; missing: string[] }> {
    return pushSecretsLib(this.target());
  }

  // ---- sync -------------------------------------------------------------

  async syncFromNpm(): Promise<void> {
    const c = this.cfg;
    console.log(`upgrading ${c.npm_package} on ${c.ssh_alias}...`);
    await runSsh(
      `bash -lc 'set -o pipefail; npm install -g ${c.npm_package} 2>&1 | tail -3'`,
      { target: this.target() },
    );
    await this.restartServer();
    console.log("  done. pirouette server restarted.");
  }

  async syncFromLocalBuild(): Promise<void> {
    const c = this.cfg;
    const repoRoot = findPackageRoot();
    console.log("building package...");
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });

    console.log("npm pack...");
    const packOut = execFileSync("npm", ["pack", "--json"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
    }).toString();
    const parsed = JSON.parse(packOut) as Array<{ filename: string }>;
    const tarballName = parsed[0]?.filename;
    if (!tarballName) throw new Error("npm pack did not report a filename");
    const onDisk = findTarball(repoRoot, tarballName);

    const remoteDir = remoteTarballsDir(c.persistent_root);
    const remoteName = path.basename(onDisk);
    const remotePath = `${remoteDir}/${remoteName}`;

    console.log(`scp ${remoteName} \u2192 ${c.ssh_alias}:${remoteDir}/`);
    await runSsh(`mkdir -p ${shellQuote(remoteDir)}`, { target: this.target() });
    await runScp(onDisk, remotePath, { target: this.target() });

    console.log("installing on remote...");
    await runSsh(
      `bash -lc 'set -o pipefail; npm install -g ${shellQuote(remotePath)} 2>&1 | tail -3'`,
      { target: this.target() },
    );

    console.log("restarting server...");
    await this.restartServer();

    try {
      unlinkSync(onDisk);
    } catch {
      /* best effort */
    }

    console.log("  sync complete.");
    console.log("  pru logs     # verify it came back up");
  }

  // ---- helpers ----------------------------------------------------------

  /** Tear down + relaunch the pirouette tmux session so a new binary takes
   *  effect. Mirrors `scripts/pirouette-bootstrap.sh`'s server-start: forwards
   *  default model / thinking level, the merged allowed_hosts (config +
   *  tailscale FQDN if known), and the configured bind_host. */
  private async restartServer(): Promise<void> {
    const c = this.cfg;
    const envPairs: string[] = [
      `PIROUETTE_DATA_DIR=${shellQuote(c.data_dir)}`,
      `PIROUETTE_PORT=${c.port}`,
      `PIROUETTE_HOST=${shellQuote(c.bind_host)}`,
    ];
    if (c.default_model) envPairs.push(`PIROUETTE_DEFAULT_MODEL=${shellQuote(c.default_model)}`);
    if (c.default_thinking_level) {
      envPairs.push(`PIROUETTE_DEFAULT_THINKING_LEVEL=${shellQuote(c.default_thinking_level)}`);
    }

    const allowedHosts = new Set<string>(c.allowed_hosts);
    const fqdn = await this.readTailscaleFqdn();
    if (fqdn) allowedHosts.add(fqdn);
    if (allowedHosts.size > 0) {
      envPairs.push(`PIROUETTE_ALLOWED_HOSTS=${shellQuote([...allowedHosts].join(","))}`);
    }

    // Build the inner server command, then nest-quote it twice: once so it's
    // a single argument to `tmux new-session`, once so the whole thing is a
    // single argument to `bash -lc`. shellQuote handles embedded single
    // quotes (the per-value quoting in envPairs) at each level, so values
    // containing spaces survive (a previous version wrapped the command in a
    // bare '...' which truncated spaced values at the first word).
    const logPath = `${c.data_dir}/logs/pirouette.log`;
    const inner = `${envPairs.join(" ")} pirouette server 2>&1 | tee -a ${shellQuote(logPath)}`;
    const tmuxCmd = `tmux new-session -d -s pirouette ${shellQuote(inner)}`;
    await runSsh(`tmux kill-session -t pirouette 2>/dev/null || true`, { target: this.target() });
    await runSsh(`bash -lc ${shellQuote(tmuxCmd)}`, { target: this.target() });
  }

  /** Read the tailscale FQDN the bootstrap writes after `tailscale serve`.
   *  Returns null if absent (non-tailscale host or not up yet). */
  private async readTailscaleFqdn(): Promise<string | null> {
    try {
      const { stdout } = await runSsh(
        `cat ${shellQuote(this.cfg.data_dir + "/tailscale-fqdn")} 2>/dev/null || true`,
        { target: this.target(), timeoutMs: 10_000 },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** Poll the remote's in-pod /api/health (server binds loopback, so we ask
   *  the remote to curl itself). */
  private async waitForServerHealthy(opts: { timeoutMs?: number } = {}): Promise<void> {
    const port = this.cfg.port;
    const deadline = Date.now() + (opts.timeoutMs ?? 3 * 60 * 1000);
    const interval = 3000;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await runSsh(
          `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/api/health 2>/dev/null || true`,
          { target: this.target(), timeoutMs: 10_000 },
        );
        if (stdout.trim() === "200") {
          console.log(`  server is up on ${this.cfg.ssh_alias}:${port}`);
          return;
        }
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(
      `pirouette server on ${this.cfg.ssh_alias} did not become healthy in ${opts.timeoutMs ?? 180_000}ms`,
    );
  }
}

/** Resolve the host the current invocation targets (honouring `--host`) and
 *  return a `Host` bound to it. */
export function getHost(
  name?: string,
  config: PirouetteConfig = getConfig(),
): Host {
  const hostName = selectHostName(name, config);
  return new Host(resolveHost(hostName, config));
}

// ---- module-private helpers ---------------------------------------------

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt + " [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

/** Single-quote a string for safe interpolation into a remote shell command,
 *  escaping embedded single quotes via the `'\''` idiom. Exported for tests. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/** Validate `--lines` for `pru logs`. Exported for tests. */
export function validateLines(raw: string | undefined): string {
  const n = Number(raw ?? "200");
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) {
    throw new Error(`--lines must be a positive integer up to 100000 (got: ${raw})`);
  }
  return String(Math.floor(n));
}

function findTarball(dir: string, reported: string): string {
  const reportedPath = path.join(dir, reported);
  const flat = reported.replace(/^@/, "").replace("/", "-");
  const flatPath = path.join(dir, flat);
  for (const p of [reportedPath, flatPath]) {
    try {
      readdirSync(path.dirname(p));
      renameSync(p, p);
      return p;
    } catch {
      /* keep looking */
    }
  }
  throw new Error(`could not locate npm pack output (tried ${reportedPath}, ${flatPath})`);
}

function findPackageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..", "..");
}
