/** ByoHostProvider — pirouette runs on an SSH-reachable host the user
 *  already manages (typically a METR k8s devpod, but any Linux box with the
 *  expected toolchain works).
 *
 *  Pirouette doesn't own the host's lifecycle here: there's no `provision a
 *  pod` step. We just SSH in, run a bootstrap script that does the home
 *  migration + dotfiles + pirouette install + tmux session, and we're done.
 *
 *  Compared to EC2:
 *    - no docker (the host IS the container)
 *    - no AWS calls (the host is whatever the user has)
 *    - no separate ssh-jump alias (a single `~/.ssh/config` entry)
 *    - persistent storage layout is configurable (persistent_root /
 *      home_dir / data_dir) rather than baked into /var/lib/pirouette
 *
 *  See docs/plans/2026-05-13-provider-abstraction.md (Phase 2) for the
 *  design. The bootstrap script the provider uploads is at
 *  `scripts/pirouette-bootstrap.sh`.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getConfig,
  resolveByoHostConfig,
  requireConfigured,
  type PirouetteConfig,
} from "../../../config.js";
import { checkLocalAuth, pushSecrets as pushSecretsLib } from "../secrets.js";
import { scp as runScp, ssh as runSsh, sshStreaming } from "../ssh.js";
import {
  clearRemoteState,
  loadRemoteState,
  updateRemoteState,
} from "../state.js";
import type {
  HostProvider,
  LogsCommand,
  LogsOptions,
  ProviderKind,
  ProviderStatus,
  SshTarget,
} from "../provider.js";

/** Where the bootstrap script lives once we scp it to the remote. /tmp is
 *  fine — it's re-uploaded on every `pru setup` / `pru sync`, so we don't
 *  need persistence. Each pod's /tmp is fresh on recreate. */
const REMOTE_BOOTSTRAP_PATH = "/tmp/pirouette-bootstrap.sh";

/** Where we scp local-build tarballs for `pru sync` (no flag). Under the
 *  persistent root so they survive recreate, but cleaned up after install. */
function remoteTarballsDir(persistentRoot: string): string {
  return `${persistentRoot}/pirouette/tarballs`;
}

/** Resolve `scripts/pirouette-bootstrap.sh` regardless of dev/built layout. */
function bootstrapScriptPath(): string {
  const here = fileURLToPath(import.meta.url);
  // src/cli/remote/providers/byo-host.ts → 4 dirs up → repo root → /scripts/
  // dist/cli/remote/providers/byo-host.js → 4 dirs up → package root → /scripts/
  return path.resolve(path.dirname(here), "..", "..", "..", "..", "scripts", "pirouette-bootstrap.sh");
}

/** Inputs the bootstrap script reads from env. Keep field names in lock-step
 *  with `scripts/pirouette-bootstrap.sh`. */
interface BootstrapEnv {
  PIROUETTE_PERSISTENT_ROOT: string;
  PIROUETTE_HOME_DIR: string;
  PIROUETTE_DATA_DIR: string;
  PIROUETTE_PACKAGE: string;
  PIROUETTE_PORT: string;
  PIROUETTE_DOTFILES_URL?: string;
  PIROUETTE_AUTHORIZED_KEYS_URL?: string;
  // Server-runtime config the bootstrap forwards into the pirouette
  // tmux session's env (so `pirouette server` on the remote knows the
  // laptop's config defaults without needing a config.toml of its own).
  PIROUETTE_DEFAULT_MODEL?: string;
  PIROUETTE_DEFAULT_THINKING_LEVEL?: string;
  PIROUETTE_ALLOWED_HOSTS?: string;
  // Tailscale (only set when tailscale.enabled).
  PIROUETTE_TS_ENABLED?: string;
  PIROUETTE_TS_HOSTNAME?: string;
  PIROUETTE_TS_STATE_PERSISTENT?: string;
}

export class ByoHostProvider implements HostProvider {
  readonly kind: ProviderKind = "byo-host";

  constructor(private cfg: PirouetteConfig = getConfig()) {}

  // ---- target resolution ------------------------------------------------

  private target() {
    const b = resolveByoHostConfig(this.cfg);
    return {
      user: b.user,
      host: b.ssh_alias,
      useAlias: true as const,
    };
  }

  // ---- HostProvider impl ------------------------------------------------

  async preflight(): Promise<void> {
    requireConfigured(this.cfg);
    const b = resolveByoHostConfig(this.cfg);

    // Verify the ssh_alias is resolvable. `ssh -G <alias>` exits 0 and
    // prints the effective config; non-zero means the alias is unknown.
    try {
      execFileSync("ssh", ["-G", b.ssh_alias], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      throw new Error(
        `ssh alias "${b.ssh_alias}" is not configured in ~/.ssh/config.\n` +
          `Add a Host block for it, or set provider.byo-host.ssh_alias to an alias that resolves.\n` +
          `Underlying error: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Verify SSH actually works. This is the byo-host equivalent of the
    // EC2 preflight's `whoami` AWS-cred check.
    console.log(`probing ssh: ${b.ssh_alias} ...`);
    const { stdout } = await runSsh("echo ok", { target: this.target(), timeoutMs: 15_000 });
    if (stdout.trim() !== "ok") {
      throw new Error(`unexpected SSH probe response: ${JSON.stringify(stdout)}`);
    }
    console.log(`  ok (logged in as ${b.user}@${b.ssh_alias})`);

    // Warn (don't fail) on missing local pi auth state — same posture as EC2.
    const auth = checkLocalAuth();
    if (!auth.ready) {
      console.log("");
      console.log("WARNING: " + auth.hint);
      console.log("");
    }
  }

  async provision(): Promise<void> {
    const cfg = this.cfg;
    const b = resolveByoHostConfig(cfg);

    // ---- upload + run the bootstrap script over SSH --------------------
    const localScript = bootstrapScriptPath();
    console.log(`uploading bootstrap script -> ${b.ssh_alias}:${REMOTE_BOOTSTRAP_PATH}`);
    await runScp(localScript, REMOTE_BOOTSTRAP_PATH, { target: this.target() });

    const env: BootstrapEnv = {
      PIROUETTE_PERSISTENT_ROOT: b.persistent_root,
      PIROUETTE_HOME_DIR: b.home_dir,
      PIROUETTE_DATA_DIR: b.data_dir,
      PIROUETTE_PACKAGE: cfg.container.npm_package,
      PIROUETTE_PORT: String(cfg.container.pirouette_port),
    };
    if (cfg.dotfiles.clone_url) env.PIROUETTE_DOTFILES_URL = cfg.dotfiles.clone_url;
    if (cfg.dotfiles.authorized_keys_url) {
      env.PIROUETTE_AUTHORIZED_KEYS_URL = cfg.dotfiles.authorized_keys_url;
    }
    // Forward server-runtime config to the bootstrap so it can plumb
    // these into the pirouette server's tmux env. Without these, the
    // remote server falls back to its (typically empty) config.toml
    // and ends up with no default model -- `@<newname> ...` flows
    // through the UI fail with "No model specified". The EC2 path
    // passes these via `docker run -e`; byo-host has no docker layer
    // so they go through the bootstrap.
    if (cfg.container.default_model) {
      env.PIROUETTE_DEFAULT_MODEL = cfg.container.default_model;
    }
    if (cfg.container.default_thinking_level) {
      env.PIROUETTE_DEFAULT_THINKING_LEVEL = cfg.container.default_thinking_level;
    }
    if (cfg.server?.allowed_hosts && cfg.server.allowed_hosts.length > 0) {
      // Server parses this comma-separated. The bootstrap merges the
      // tailscale FQDN onto this list (rather than replacing) when
      // tailscale is enabled.
      env.PIROUETTE_ALLOWED_HOSTS = cfg.server.allowed_hosts.join(",");
    }
    if (b.tailscale.enabled) {
      env.PIROUETTE_TS_ENABLED = "1";
      env.PIROUETTE_TS_HOSTNAME = b.tailscale.hostname;
      env.PIROUETTE_TS_STATE_PERSISTENT = b.tailscale.state_persistent ? "1" : "0";
    }

    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(" ");

    if (b.tailscale.enabled) {
      console.log(
        `running bootstrap (this may take a few minutes on first run;` +
          ` tailscale auth is interactive — watch for a login URL below)...`,
      );
    } else {
      console.log(`running bootstrap (this may take a minute on first run)...`);
    }

    // Stream the bootstrap output live (not buffered). Critical for
    // tailscale.enabled because `tailscale up` prints a login URL the
    // user must approve in a browser — buffering would hide the URL
    // until ssh times out. Also a UX win for the slow bootstrap steps
    // (npm install, yadm clone) which feel hung when buffered.
    // `bash -l` so the script inherits login-shell PATH (npm prefix,
    // node, yadm location).
    await sshStreaming(
      `chmod +x ${REMOTE_BOOTSTRAP_PATH} && ${envPrefix} bash -l ${REMOTE_BOOTSTRAP_PATH}`,
      { target: this.target(), timeoutMs: 15 * 60 * 1000 },
    );

    // ---- push secrets (idempotent overwrite) ---------------------------
    console.log("pushing local auth secrets...");
    const sec = await this.pushSecrets();
    if (sec.pushed === 0 && sec.missing.length > 0) {
      console.log(
        `  (none pushed; pi providers will need /login on first use. Missing: ${sec.missing.join(", ")})`,
      );
    }

    // ---- record state --------------------------------------------------
    updateRemoteState({
      kind: "byo-host",
      sshAlias: b.ssh_alias,
      sshUser: b.user,
      persistentRoot: b.persistent_root,
      homeDir: b.home_dir,
      dataDir: b.data_dir,
      createdAt: loadRemoteState().createdAt ?? new Date().toISOString(),
    });

    // ---- wait for server ready -----------------------------------------
    console.log("waiting for pirouette server to be healthy...");
    await this.waitForServerHealthy({ timeoutMs: 3 * 60 * 1000 });

    // ---- read tailscale FQDN if the bootstrap wrote one ----------------
    let tsFqdn: string | null = null;
    if (b.tailscale.enabled) {
      try {
        const { stdout } = await runSsh(
          `cat ${shellQuote(b.data_dir + "/tailscale-fqdn")} 2>/dev/null || true`,
          { target: this.target(), timeoutMs: 10_000 },
        );
        tsFqdn = stdout.trim() || null;
      } catch {
        /* best effort */
      }
    }

    console.log("");
    console.log("  setup complete.");
    if (tsFqdn) {
      console.log(`  Tailscale: https://${tsFqdn} (reachable from any tailnet device)`);
      console.log(`    set on your laptop:`);
      console.log(`      export PIROUETTE_URL=https://${tsFqdn}`);
      console.log(`    or add to ~/.pirouette/config.toml:`);
      console.log(`      [server]`);
      console.log(`      public_url    = "https://${tsFqdn}"`);
      console.log(`      allowed_hosts = ["${tsFqdn}"]`);
      console.log("");
      console.log(`  Or fall back to SSH tunnel (always works):`);
      console.log(`    ssh -fN -L ${cfg.container.pirouette_port}:localhost:${cfg.container.pirouette_port} ${b.ssh_alias}`);
      console.log(`    export PIROUETTE_URL=http://localhost:${cfg.container.pirouette_port}`);
    } else {
      console.log(`  Open an SSH tunnel from your laptop:`);
      console.log(`    ssh -fN -L ${cfg.container.pirouette_port}:localhost:${cfg.container.pirouette_port} ${b.ssh_alias}`);
      console.log(`  Then:`);
      console.log(`    export PIROUETTE_URL=http://localhost:${cfg.container.pirouette_port}`);
      console.log(`    pru open`);
    }
    console.log("");
    console.log(`  pru ssh          # shell into ${b.ssh_alias}`);
    console.log(`  pru logs         # tail server logs`);
    console.log(`  pru status       # check server health`);
  }

  async stop(): Promise<void> {
    // byo-host: pirouette doesn't own the host's lifecycle. We just kill
    // the pirouette tmux session so the server isn't sitting idle. The
    // host stays up, persistent state survives.
    const state = loadRemoteState();
    if (state.kind !== "byo-host") {
      console.log("no byo-host state; nothing to do.");
      return;
    }
    console.log(`stopping pirouette tmux session on ${state.sshAlias}...`);
    try {
      await runSsh(`tmux kill-session -t pirouette 2>/dev/null || true`, {
        target: this.target(),
      });
      console.log("  done.");
    } catch (err) {
      console.log(`  warning: ${err instanceof Error ? err.message : err}`);
    }
    console.log(
      `  Host is still running; persistent state preserved. pru setup to resume.`,
    );
  }

  async destroy(opts: { deletePersistent: boolean; yes?: boolean }): Promise<void> {
    const state = loadRemoteState();
    if (state.kind !== "byo-host") {
      console.log("no byo-host state; nothing to destroy.");
      return;
    }

    console.log("about to clean up:");
    console.log(`  local:     ~/.pirouette/host.json`);
    if (opts.deletePersistent) {
      console.log(`  remote:    rm -rf ${state.dataDir} ${state.homeDir}`);
      console.log(`  (pirouette doesn't own ${state.sshAlias}; the host itself stays up)`);
    } else {
      console.log(`  remote:    nothing (pass --delete-volume to nuke persistent state)`);
    }

    if (!opts.yes) {
      const sure = await confirm("proceed?");
      if (!sure) {
        console.log("cancelled.");
        return;
      }
    }

    // Stop the server first so files aren't being written to as we rm.
    try {
      await runSsh(`tmux kill-session -t pirouette 2>/dev/null || true`, {
        target: this.target(),
      });
    } catch {
      /* best effort */
    }

    if (opts.deletePersistent && state.dataDir && state.homeDir) {
      console.log(`nuking persistent dirs on ${state.sshAlias}...`);
      // Refuse to rm $HOME if it's NOT the symlinked persistent target —
      // someone may have manually rolled back the migration. The unlink
      // step at the end clears the symlink itself.
      const home = `/home/${state.sshUser}`;
      await runSsh(
        `set -e; ` +
          `rm -rf ${shellQuote(state.dataDir)} ${shellQuote(state.homeDir)}; ` +
          `if [ -L ${shellQuote(home)} ] && [ "$(readlink ${shellQuote(home)})" = ${shellQuote(state.homeDir)} ]; then ` +
          `  sudo unlink ${shellQuote(home)}; ` +
          `fi`,
        { target: this.target() },
      );
      console.log("  done.");
    }

    clearRemoteState();
    console.log("  cleared local state.");
  }

  async status(): Promise<ProviderStatus> {
    const state = loadRemoteState();
    if (state.kind !== "byo-host" || !state.sshAlias) {
      return { state: "absent", detail: "no byo-host state", sshTarget: null };
    }

    const extra: string[] = [
      `  alias      ${state.sshAlias}`,
      `  user       ${state.sshUser ?? "\u2014"}`,
      `  data dir   ${state.dataDir ?? "\u2014"}`,
      `  home dir   ${state.homeDir ?? "\u2014"}`,
    ];

    // Probe several things in one round-trip:
    //   1. is the home symlink intact and pointing at the persistent target?
    //   2. is the pirouette tmux session running?
    //   3. does the data dir exist and is the log file written?
    //   4. tailscale FQDN (if tailscale was set up during bootstrap)
    // Output is line-by-line; we parse and emit health icons. Best-effort:
    // don't fail status() on transient SSH errors.
    let coarse: ProviderStatus["state"] = "unknown";
    if (state.sshUser && state.homeDir && state.dataDir) {
      const home = `/home/${state.sshUser}`;
      const probe =
        `if [ -L ${shellQuote(home)} ] && [ "$(readlink ${shellQuote(home)})" = ${shellQuote(state.homeDir)} ]; then echo SYMLINK_OK; else echo SYMLINK_BAD; fi; ` +
        `tmux has-session -t pirouette 2>/dev/null && echo TMUX_RUNNING || echo TMUX_STOPPED; ` +
        `if [ -d ${shellQuote(state.dataDir)} ]; then echo DATA_DIR_OK; else echo DATA_DIR_MISSING; fi; ` +
        `echo TS_FQDN="$(cat ${shellQuote(state.dataDir + "/tailscale-fqdn")} 2>/dev/null || echo none)"`;
      try {
        const { stdout } = await runSsh(probe, {
          target: this.target(),
          timeoutMs: 15_000,
        });
        const lines = stdout.trim().split("\n").map((l) => l.trim());
        const symlinkOk = lines.includes("SYMLINK_OK");
        const tmuxRunning = lines.includes("TMUX_RUNNING");
        const dataDirOk = lines.includes("DATA_DIR_OK");
        const tsLine = lines.find((l) => l.startsWith("TS_FQDN="));
        const tsFqdn = tsLine ? tsLine.slice("TS_FQDN=".length) : "none";
        coarse = tmuxRunning ? "running" : "stopped";
        extra.push(
          `  home swap  ${symlinkOk ? "\u2705 ok" : "\u26a0 not symlinked to home_dir (run \`pru setup\`?)"}`,
        );
        extra.push(`  data dir   ${dataDirOk ? "\u2705 present" : "\u26a0 missing"} (${state.dataDir})`);
        extra.push(`  tmux       ${tmuxRunning ? "\u2705 running" : "\u26a0 stopped"}`);
        if (tsFqdn !== "none" && tsFqdn !== "") {
          extra.push(`  tailscale  \u2705 https://${tsFqdn}`);
        }
      } catch (err) {
        extra.push(`  health     unreachable (${err instanceof Error ? err.message : err})`);
      }
    }

    return {
      state: coarse,
      detail: `${state.sshAlias} (${coarse})`,
      sshTarget: this.sshTarget(),
      extraLines: extra,
    };
  }

  sshTarget(): SshTarget {
    const state = loadRemoteState();
    if (state.kind !== "byo-host" || !state.sshAlias) {
      throw new Error("No byo-host configured. Run `pru setup` first.");
    }
    return {
      user: state.sshUser ?? this.cfg.provider["byo-host"].user,
      host: state.sshAlias,
      useAlias: true,
    };
  }

  buildLogsCommand(opts: LogsOptions): LogsCommand {
    const b = resolveByoHostConfig(this.cfg);
    const lines = validateLines(opts.lines);
    const follow = opts.follow ? "-f" : "";
    const pirouetteLog = `${b.data_dir}/logs/pirouette.log`;
    const bootstrapLog = `${b.home_dir}/logs/bootstrap.log`;

    let command: string;
    if (opts.boot) {
      // No analogue on byo-host (no cloud-init). Surface a clear message.
      command = `echo '(--boot is not applicable on byo-host; the host bootstrap is the image entrypoint, see provider.byo-host.image logs in the platform that hosts it)'`;
    } else if (opts.entrypoint) {
      command = `tail -n ${lines} ${follow} ${bootstrapLog} 2>/dev/null || echo '(bootstrap log not ready yet)'`;
    } else if (opts.tmux) {
      command = `tmux capture-pane -p -S -${lines} -t pirouette 2>/dev/null || echo '(pirouette tmux session not running)'`;
    } else {
      command = `[ -f ${pirouetteLog} ] && tail -n ${lines} ${follow} ${pirouetteLog} || (echo '(pirouette.log not ready; showing bootstrap log)' && tail -n ${lines} ${follow} ${bootstrapLog})`;
    }

    return { command, sshAlias: b.ssh_alias };
  }

  shellAlias(): string {
    // For byo-host, the same alias is the shell target. No ProxyJump dance.
    const b = resolveByoHostConfig(this.cfg);
    return process.env.PIROUETTE_SSH_HOST ?? b.ssh_alias;
  }

  async pushSecrets(): Promise<{ pushed: number; skipped: number; missing: string[] }> {
    return pushSecretsLib(this.cfg, { mode: "plain-ssh", target: this.target() });
  }

  async syncFromNpm(): Promise<void> {
    const cfg = this.cfg;
    console.log(`upgrading ${cfg.container.npm_package} on ${this.target().host}...`);
    await runSsh(
      `bash -lc 'set -o pipefail; npm install -g ${cfg.container.npm_package} 2>&1 | tail -3'`,
      { target: this.target() },
    );
    await this.restartServer();
    console.log("  done. pirouette server restarted.");
  }

  async syncFromLocalBuild(): Promise<void> {
    const b = resolveByoHostConfig(this.cfg);
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

    const remoteDir = remoteTarballsDir(b.persistent_root);
    const remoteName = path.basename(onDisk);
    const remotePath = `${remoteDir}/${remoteName}`;

    console.log(`scp ${remoteName} \u2192 ${this.target().host}:${remoteDir}/`);
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

  /** Tear down + relaunch the pirouette tmux session so the new pirouette
   *  binary takes effect. Matches `scripts/pirouette-bootstrap.sh`'s tmux
   *  launch line, including the 127.0.0.1 bind (Decision 6). */
  private async restartServer(): Promise<void> {
    const b = resolveByoHostConfig(this.cfg);
    await runSsh(`tmux kill-session -t pirouette 2>/dev/null || true`, {
      target: this.target(),
    });
    await runSsh(
      `bash -lc "tmux new-session -d -s pirouette 'PIROUETTE_DATA_DIR=${shellQuote(b.data_dir)} PIROUETTE_PORT=${this.cfg.container.pirouette_port} PIROUETTE_HOST=127.0.0.1 pirouette server 2>&1 | tee -a ${shellQuote(b.data_dir + "/logs/pirouette.log")}'"`,
      { target: this.target() },
    );
  }

  /** Poll the in-pod /api/health endpoint over SSH (since the server is
   *  bound to 127.0.0.1 on the remote, we ask the remote to curl itself).
   *  Same idea as the EC2 path's `waitForServerReady` but over plain SSH
   *  instead of `docker exec`. */
  private async waitForServerHealthy(opts: { timeoutMs?: number } = {}): Promise<void> {
    const port = this.cfg.container.pirouette_port;
    const deadline = Date.now() + (opts.timeoutMs ?? 3 * 60 * 1000);
    const interval = 3000;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await runSsh(
          `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/api/health 2>/dev/null || true`,
          { target: this.target(), timeoutMs: 10_000 },
        );
        if (stdout.trim() === "200") {
          console.log(`  server is up on ${this.target().host}:${port}`);
          return;
        }
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(
      `pirouette server on ${this.target().host} did not become healthy in ${opts.timeoutMs ?? 180_000}ms`,
    );
  }
}

// ---- shared helpers (kept private to byo-host) --------------------------

async function confirm(prompt: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt + " [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

function validateLines(raw: string | undefined): string {
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
  return path.resolve(path.dirname(here), "..", "..", "..", "..");
}

// readFileSync is referenced for type-only purposes by some Node lint configs;
// keep an import to avoid tsc tree-shaking complaints in test environments.
void readFileSync;
