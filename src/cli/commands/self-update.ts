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
 *  the restart, installs the new build, and bounces the service. The
 *  agent's `pru self-update` call, meanwhile, returns immediately.
 *
 *  After the restart, the new server's `resumeAll()` brings every agent
 *  that was running back (they were persisted as "shutdown" state on the
 *  old server's graceful exit), so the agent that kicked off the update
 *  simply resumes with its conversation intact.
 *
 *  Two install sources:
 *    - npm (default): `npm install -g <spec>` from the registry. The
 *      published tarball ships prebuilt `dist/`, so nothing is compiled on
 *      the host. This is the normal path once a version is published.
 *    - git (`--from-git`, or a git-ish `--package`): clone the repo, run
 *      `npm ci` + `npm run build` + `npm pack`, then install the tarball.
 *      This exists because `npm install -g <git-ref>` does NOT install a
 *      package's devDependencies when running its `prepare` script, so the
 *      build tooling (esbuild/tsc/...) is missing and the build fails. A
 *      fresh clone treated as the *root* project DOES get devDependencies
 *      via `npm ci`, so building there works. Lets agents self-update to
 *      an unreleased commit straight from GitHub.
 *
 *  This is a LOCAL command: it acts on the machine it runs on (the host).
 *  To update a remote host from your laptop, use `pru sync` / `pru sync
 *  --npm`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SelfUpdateOptions {
  /** Full npm spec to install, e.g. "@neevparikh/pirouette@1.2.3". A
   *  git-ish value (github:owner/repo, git+https://..., ...) auto-selects
   *  the git build mode. Wins over --target. */
  package?: string;
  /** Version / dist-tag to install for the resolved npm package name, e.g.
   *  "latest" or "1.2.3". Combined with the detected package name. */
  target?: string;
  /** Build + install from a git clone. Value is an optional git ref
   *  (branch / tag / sha); with no value it builds the repo's default
   *  branch. The repo URL comes from the installed package.json
   *  `repository.url` unless a git URL is given via --package. */
  fromGit?: string | boolean;
  /** Git ref (branch/tag/sha) to build. Applies in git mode; overrides a
   *  ref embedded in --package or --from-git. */
  ref?: string;
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
const FALLBACK_GIT_URL = "https://github.com/neevparikh/pirouette.git";

/** Strip a version/dist-tag suffix from an npm spec, keeping any leading
 *  scope. "@scope/name@1.2.3" -> "@scope/name"; "name@latest" -> "name";
 *  "@scope/name" / "name" -> unchanged. */
export function packageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  // at <= 0 means either no "@" at all, or only the scope "@" at index 0.
  return at <= 0 ? spec : spec.slice(0, at);
}

export interface GitSource {
  url: string;
  ref?: string;
}

/** Recognise and normalise a git dependency spec into a clone URL (+ ref).
 *  Returns null for plain npm specs. Handles:
 *    - github:owner/repo[#ref]      -> https://github.com/owner/repo.git
 *    - git+https://host/x.git[#ref] -> https://host/x.git
 *    - https://host/x.git[#ref]     -> as-is
 *    - git@host:owner/repo.git[#ref]-> as-is (ssh)
 *  A `#ref` fragment becomes `ref`. */
export function parseGitSpec(spec: string): GitSource | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  const hash = trimmed.indexOf("#");
  const base = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
  const ref = hash >= 0 ? trimmed.slice(hash + 1) || undefined : undefined;

  // github:owner/repo shorthand.
  const gh = /^github:(.+?)\/(.+)$/i.exec(base);
  if (gh) {
    const repo = gh[2].replace(/\.git$/i, "");
    return { url: `https://github.com/${gh[1]}/${repo}.git`, ref };
  }

  // git+<url> — strip the npm "git+" transport prefix.
  if (/^git\+/i.test(base)) {
    return { url: base.replace(/^git\+/i, ""), ref };
  }

  // ssh form: git@host:owner/repo(.git)
  if (/^[^@\s]+@[^:\s]+:.+/.test(base) && /\.git$/i.test(base)) {
    return { url: base, ref };
  }

  // http(s) URL that is clearly a git repo.
  if (/^https?:\/\/.+/i.test(base) && (/\.git$/i.test(base) || /github\.com|gitlab\.com|bitbucket\.org/i.test(base))) {
    return { url: base, ref };
  }

  return null;
}

export type InstallPlan =
  | { mode: "npm"; spec: string }
  | { mode: "git"; url: string; ref?: string };

/** Decide what to install and from where. Precedence:
 *    1. --from-git         -> git build of the default repo (ref from the
 *       flag value or --ref).
 *    2. git-ish --package  -> git build of that URL (ref from #frag or
 *       --ref).
 *    3. otherwise          -> npm install of the resolved spec. */
export function resolveInstallPlan(
  opts: Pick<SelfUpdateOptions, "package" | "target" | "fromGit" | "ref">,
  env: NodeJS.ProcessEnv,
  readSentinel: () => string | undefined,
  defaultGitUrl: () => string,
): InstallPlan {
  if (opts.fromGit !== undefined && opts.fromGit !== false) {
    const refFromFlag = typeof opts.fromGit === "string" ? opts.fromGit.trim() : "";
    return {
      mode: "git",
      url: defaultGitUrl(),
      ref: opts.ref?.trim() || refFromFlag || undefined,
    };
  }
  if (opts.package) {
    const git = parseGitSpec(opts.package);
    if (git) return { mode: "git", url: git.url, ref: opts.ref?.trim() || git.ref };
  }
  return { mode: "npm", spec: resolvePackageSpec(opts, env, readSentinel) };
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
  return path.resolve(packageRoot(), "scripts", "pirouette-self-update.sh");
}

/** The installed package's root directory (three up from this module in
 *  both the src and dist layouts). */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

/** Clone URL for --from-git: the installed package.json `repository.url`,
 *  normalised for `git clone` (drop any "git+" prefix). Falls back to the
 *  public GitHub URL if package.json can't be read. */
function defaultGitUrl(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(packageRoot(), "package.json"), "utf8"),
    ) as { repository?: string | { url?: string } };
    const raw =
      typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    if (raw) return raw.replace(/^git\+/i, "");
  } catch {
    // fall through to the hard-coded default
  }
  return FALLBACK_GIT_URL;
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

/** Human summary of what an install plan will do. */
function describePlan(plan: InstallPlan): string {
  return plan.mode === "git"
    ? `git build of ${plan.url}${plan.ref ? ` @ ${plan.ref}` : " (default branch)"}`
    : `npm install ${plan.spec}`;
}

/** The worker-script env vars implied by an install plan. The worker
 *  branches on PIROUETTE_UPDATE_GIT_URL: present -> git build mode. */
function planEnv(plan: InstallPlan): Record<string, string> {
  if (plan.mode === "git") {
    return {
      PIROUETTE_UPDATE_GIT_URL: plan.url,
      ...(plan.ref ? { PIROUETTE_UPDATE_GIT_REF: plan.ref } : {}),
    };
  }
  return { PIROUETTE_PACKAGE: plan.spec };
}

export async function selfUpdate(opts: SelfUpdateOptions): Promise<void> {
  const env = process.env;
  const dataDir = env.PIROUETTE_DATA_DIR;
  const plan = resolveInstallPlan(
    opts,
    env,
    () => readPackageSentinel(dataDir),
    defaultGitUrl,
  );
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
    ...planEnv(plan),
    PIROUETTE_SERVICE_NAME: service,
    PIROUETTE_UPDATE_SETTLE: settle,
    ...(dataDir ? { PIROUETTE_DATA_DIR: dataDir } : {}),
  };

  // Foreground / debug path: run the worker right here. Note this will be
  // killed by the restart if invoked from inside an agent — it exists for
  // manual debugging on a host shell.
  if (opts.foreground) {
    console.log(`[self-update] running worker in foreground: ${describePlan(plan)}`);
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
        "`pru sync` instead. (For a manual run on this machine, try " +
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
    ...Object.entries(workerEnv).map(([k, v]) => `--setenv=${k}=${v}`),
    "bash",
    script,
  ];

  console.log(`[self-update] launching detached updater: ${describePlan(plan)}`);
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
      `  It will ${describePlan(plan)}, restart '${service}', and this server\n` +
      `  will resume all running agents on boot. This command's process may\n` +
      `  be torn down by the restart — that's expected and safe.\n` +
      `  Follow progress:  journalctl -u ${unit} -f\n` +
      `             or:  pru logs   (after the restart)`,
  );
}
