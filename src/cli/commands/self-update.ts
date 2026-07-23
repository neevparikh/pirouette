/** `pru self-update` — update *this* pirouette instance from the inside.
 *
 *  Why this exists (and why it isn't just `npm install -g && systemctl
 *  restart`):
 *
 *  Agents run in-process inside the pirouette server, and every command
 *  they shell out to (via pi's bash tool) is a child process in
 *  `pirouette.service`'s systemd cgroup. So the naive update sequence an
 *  agent might try —
 *
 *      npm install -g @neevparikh/pirouette@latest
 *      sudo systemctl restart pirouette
 *
 *  — self-destructs: the moment the service restarts, systemd kills the
 *  whole cgroup, including the very bash command running the restart. Any
 *  follow-on steps never execute, and the agent's turn dies mid-flight.
 *
 *  `pru self-update` fixes this by NOT doing the work in the agent's
 *  process tree. It launches `scripts/pirouette-self-update.sh` into its
 *  own systemd transient unit (`sudo systemd-run`), i.e. a separate
 *  cgroup that is NOT a child of pirouette.service. That worker survives
 *  the restart, installs the new package, and bounces the service. The
 *  agent's `pru self-update` call, meanwhile, returns immediately.
 *
 *  After the restart, the new server's `resumeAll()` brings every agent
 *  that was running back (they were persisted as "shutdown" state on the
 *  old server's graceful exit), so the agent that kicked off the update
 *  simply resumes with its conversation intact.
 *
 *  This is a LOCAL command: it acts on the machine it runs on (the host).
 *  To update a remote host from your laptop, use `pru sync --npm`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SelfUpdateOptions {
  /** Full npm spec to install, e.g. "@neevparikh/pirouette@1.2.3". Wins
   *  over --target. */
  package?: string;
  /** Version / dist-tag to install for the resolved package name, e.g.
   *  "latest" or "1.2.3". Combined with the detected package name. */
  target?: string;
  /** systemd unit name for the transient worker (default
   *  "pirouette-self-update"). */
  unit?: string;
  /** systemd service to restart (default "pirouette"). */
  service?: string;
  /** Seconds the worker waits before starting, so this command can return
   *  first (default 2). */
  settle?: string;
  /** Run the worker synchronously in THIS process instead of a detached
   *  transient unit. Mostly for debugging — an agent that uses this will
   *  get killed by the restart, which is the whole thing we're avoiding. */
  foreground?: boolean;
}

const DEFAULT_PACKAGE = "@neevparikh/pirouette";
const DEFAULT_UNIT = "pirouette-self-update";
const DEFAULT_SERVICE = "pirouette";

/** Strip a version/dist-tag suffix from an npm spec, keeping any leading
 *  scope. "@scope/name@1.2.3" -> "@scope/name"; "name@latest" -> "name";
 *  "@scope/name" / "name" -> unchanged. */
export function packageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  // at <= 0 means either no "@" at all, or only the scope "@" at index 0.
  return at <= 0 ? spec : spec.slice(0, at);
}

/** Resolve the npm spec to install from the CLI flags, environment, and
 *  the on-disk sentinel the bootstrap writes, falling back to the public
 *  package name. `--package` is authoritative; `--target` re-pins the
 *  version of whatever base name we resolve. */
export function resolvePackageSpec(
  opts: Pick<SelfUpdateOptions, "package" | "target">,
  env: NodeJS.ProcessEnv,
  readSentinel: () => string | undefined,
): string {
  if (opts.package) return opts.package;
  const base =
    env.PIROUETTE_PACKAGE?.trim() ||
    readSentinel()?.trim() ||
    DEFAULT_PACKAGE;
  const target = opts.target?.trim();
  if (target) return `${packageName(base)}@${target}`;
  // No explicit target: if the base carries no version tag, default to
  // @latest so "self-update" actually moves forward rather than
  // reinstalling the pinned version.
  return packageName(base) === base ? `${base}@latest` : base;
}

/** Locate the shipped worker script. Resolves the same in dev
 *  (src/cli/commands/*.ts) and built (dist/cli/commands/*.js) layouts:
 *  the package root is three directories up, and `scripts/` ships with
 *  the package (see package.json "files"). */
function resolveWorkerScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "scripts", "pirouette-self-update.sh");
}

function readPackageSentinel(dataDir: string | undefined): string | undefined {
  if (!dataDir) return undefined;
  const p = path.join(dataDir, "npm-package");
  try {
    const v = readFileSync(p, "utf8").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** True if `systemd-run` is on PATH — our signal that we're on a real
 *  systemd host where the detached-worker trick works. */
function hasSystemdRun(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v systemd-run"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function selfUpdate(opts: SelfUpdateOptions): Promise<void> {
  const env = process.env;
  const dataDir = env.PIROUETTE_DATA_DIR;
  const spec = resolvePackageSpec(opts, env, () => readPackageSentinel(dataDir));
  const service = opts.service || DEFAULT_SERVICE;
  const unit = opts.unit || DEFAULT_UNIT;
  const settle = opts.settle ?? "2";
  const script = resolveWorkerScript();

  if (!existsSync(script)) {
    throw new Error(
      `self-update worker not found at ${script}. Is the package install intact?`,
    );
  }

  const workerEnv = {
    PIROUETTE_PACKAGE: spec,
    PIROUETTE_SERVICE_NAME: service,
    PIROUETTE_UPDATE_SETTLE: settle,
    ...(dataDir ? { PIROUETTE_DATA_DIR: dataDir } : {}),
  };

  // Foreground / debug path: run the worker right here. Note this will be
  // killed by the restart if invoked from inside an agent — it exists for
  // manual debugging on a host shell.
  if (opts.foreground) {
    console.log(`[self-update] running worker in foreground: ${spec}`);
    execFileSync("bash", [script], {
      stdio: "inherit",
      env: { ...env, ...workerEnv },
    });
    return;
  }

  if (!hasSystemdRun()) {
    throw new Error(
      "`systemd-run` not found. `pru self-update` runs on a pirouette host " +
        "with systemd. To update a remote host from your laptop, use " +
        "`pru sync --npm` instead. (For a manual run on this machine, try " +
        "`pru self-update --foreground`.)",
    );
  }

  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const home = env.HOME ?? "";
  const pathEnv =
    env.PATH ??
    `${home}/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

  // Clear any leftover transient unit with the same name from a prior run
  // (a still-*running* one will make systemd-run fail below — which is the
  // right behaviour: an update is already in flight).
  try {
    execFileSync("sudo", ["systemctl", "reset-failed", `${unit}.service`], {
      stdio: "ignore",
    });
  } catch {
    // nothing to reset — fine.
  }

  const args = [
    "systemd-run",
    `--unit=${unit}`,
    "--collect",
    "--property=Type=oneshot",
    `--uid=${uid}`,
    `--gid=${gid}`,
    `--setenv=HOME=${home}`,
    `--setenv=PATH=${pathEnv}`,
    `--setenv=PIROUETTE_PACKAGE=${spec}`,
    `--setenv=PIROUETTE_SERVICE_NAME=${service}`,
    `--setenv=PIROUETTE_UPDATE_SETTLE=${settle}`,
    ...(dataDir ? [`--setenv=PIROUETTE_DATA_DIR=${dataDir}`] : []),
    "bash",
    script,
  ];

  console.log(`[self-update] launching detached updater for ${spec}`);
  try {
    execFileSync("sudo", args, { stdio: "inherit" });
  } catch (err) {
    throw new Error(
      `failed to launch self-update unit '${unit}': ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `If '${unit}' is already running, an update is already in progress ` +
        `(watch it with: journalctl -u ${unit} -f).`,
    );
  }

  console.log(
    `[self-update] update kicked off in a detached systemd unit ('${unit}').\n` +
      `  It will reinstall ${spec}, restart '${service}', and this server\n` +
      `  will resume all running agents on boot. This command's process may\n` +
      `  be torn down by the restart — that's expected and safe.\n` +
      `  Follow progress:  journalctl -u ${unit} -f\n` +
      `             or:  pru logs   (after the restart)`,
  );
}
