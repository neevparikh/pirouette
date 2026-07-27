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
 *  old server's graceful exit) and re-kicks the ones whose turn the
 *  restart cut short, so in-flight work continues instead of stalling.
 *  The restart also kills every bash command the agents had running --
 *  that is accepted and expected; the agents are told about it and pick
 *  up from there.
 *
 *  This command additionally drops a "restart notice" (see
 *  src/server/restart-notice.ts) naming the agent that invoked it, so the
 *  new server can wake that agent too. Without it, the *initiating* agent
 *  is the one agent that reliably does NOT auto-resume: its turn has
 *  already ended by the time the installer restarts the service, so it
 *  looks "finished" rather than "interrupted".
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

import {
  agentSessionDirFromEnv,
  writeRestartNotice,
} from "../../server/restart-notice.js";

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
  /** Skip the "don't move backwards" guard: install the resolved version
   *  even if it is older than, or identical to, what's running. */
  force?: boolean;
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

/** The version / dist-tag part of an npm spec, or undefined if it's a bare
 *  name. "@scope/name@1.2.3" -> "1.2.3"; "name@latest" -> "latest". */
export function specVersion(spec: string): string | undefined {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return undefined;
  return spec.slice(at + 1) || undefined;
}

/** True if `v` looks like a concrete semver version rather than a dist-tag
 *  ("1.2.3", "1.2.3-rc.1" vs "latest", "next"). Naming an exact version is
 *  explicit intent, so the downgrade guard steps out of the way for it. */
export function isExactVersion(v: string | undefined): boolean {
  return !!v && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(v.trim());
}

/** Compare two semver-ish versions: -1 if a < b, 0 if equal, 1 if a > b.
 *
 *  Hand-rolled because pirouette ships four runtime dependencies and this
 *  is not worth a fifth. Covers what we actually compare -- released
 *  versions and the occasional prerelease -- per semver rules: numeric
 *  fields compare numerically, a prerelease sorts BEFORE its release, and
 *  build metadata (+foo) is ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.trim().replace(/^v/i, "").split("+", 1)[0];
    const dash = clean.indexOf("-");
    const main = dash >= 0 ? clean.slice(0, dash) : clean;
    const pre = dash >= 0 ? clean.slice(dash + 1) : "";
    return {
      nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: pre ? pre.split(".") : [],
    };
  };
  const pa = parse(a);
  const pb = parse(b);

  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }

  // 1.0.0-rc.1 < 1.0.0
  if (pa.pre.length === 0 && pb.pre.length > 0) return 1;
  if (pa.pre.length > 0 && pb.pre.length === 0) return -1;

  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers sort below alphanumeric
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

export type VersionVerdict =
  | { action: "proceed" }
  | { action: "up-to-date"; message: string }
  | { action: "refuse"; message: string };

/** Decide whether an npm-mode install should actually happen.
 *
 *  This exists because of a real foot-gun: the npm dist-tag can be *behind*
 *  what's running. On our own host, `latest` was 0.14.2 while the box ran
 *  0.16.1 (built from git) -- so a bare `pru self-update` would have
 *  silently rolled the whole fleet back two minor versions, restarting
 *  every agent to do it.
 *
 *  Rules:
 *    - target newer than installed  -> proceed.
 *    - target identical             -> nothing to do. Notably we do NOT
 *      restart: an update command that's a no-op should be a no-op, not a
 *      fleet-wide interruption. (A pinned exact version is allowed through
 *      as a deliberate reinstall/repair.)
 *    - target older                 -> refuse. `--force` is the ONLY way
 *      through, whether or not the version was pinned.
 *    - anything unknown (no installed version, registry lookup failed,
 *      unparseable) -> proceed. A flaky lookup must not be able to block
 *      updates; the guard is a safety net, not a gate.
 *
 *  Pinning an exact version deliberately does NOT unlock a downgrade. An
 *  earlier draft of this function treated `--package pkg@1.2.3` as
 *  "explicit intent, let it through", and that is precisely the command
 *  that rolled this project's own host from 0.16.1 back to 0.14.2 and
 *  destroyed 64 `archived` flags. Naming a version says which build you
 *  want; it says nothing about having understood that the fleet is about
 *  to move backwards across a state-schema boundary. Those are different
 *  decisions and they need different evidence. */
export function judgeVersionChange(opts: {
  installed?: string;
  target?: string;
  /** The user named an exact version rather than a dist-tag. */
  pinned: boolean;
  force: boolean;
  /** For the message: what we're installing, e.g. "@scope/pkg@latest". */
  spec: string;
}): VersionVerdict {
  const { installed, target, pinned, force, spec } = opts;
  if (force || !installed || !target) return { action: "proceed" };

  const cmp = compareVersions(target, installed);
  if (cmp > 0) return { action: "proceed" };

  if (cmp === 0) {
    if (pinned) return { action: "proceed" };
    return {
      action: "up-to-date",
      message:
        `Already on ${installed} — ${spec} resolves to the same version.\n` +
        `  Nothing to do: no install, no restart, agents left alone.\n` +
        `  Reinstall anyway with:  pru self-update --force`,
    };
  }

  return {
    action: "refuse",
    message:
      `Refusing to self-update: ${spec} resolves to ${target}, but this host ` +
      `is running ${installed} — that's a downgrade.\n` +
      `  (A published release behind the running code is normal when the host ` +
      `was installed from git.)\n` +
      `\n` +
      `  Moving a live fleet backwards restarts every agent, and an older ` +
      `build can silently drop\n` +
      `  state fields it doesn't know about — that is how 64 archived flags ` +
      `were destroyed here once.\n` +
      `\n` +
      `  For unreleased code, build from git instead:\n` +
      `      pru self-update --from-git\n` +
      `\n` +
      `  If you genuinely mean to roll back, say so explicitly — and back up ` +
      `the state file first:\n` +
      `      cp <data-dir>/state/pirouette-state.json{,.bak}\n` +
      `      pru self-update --package ${packageName(spec)}@${target} --force`,
  };
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

/** Version of the pirouette that's running right now (from the installed
 *  package.json). Undefined if it can't be read — the guard then stands
 *  down rather than blocking the update. */
function installedVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(packageRoot(), "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Ask the registry what a spec actually resolves to. Returns undefined on
 *  any failure (offline, private registry, unpublished package) — callers
 *  treat "unknown" as "proceed". */
export function resolveRegistryVersion(spec: string): string | undefined {
  try {
    const out = execFileSync("npm", ["view", spec, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
    // `npm view` can print multiple lines for a range; take the last, which
    // is the highest match.
    const lines = out.trim().split(/\s+/).filter(Boolean);
    const last = lines[lines.length - 1];
    return last ? last.replace(/^.*'(.+)'$/, "$1") : undefined;
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

  // Don't move backwards. Only npm mode can be judged up front: a git ref
  // has no version until it's built, and asking for one is the whole point
  // of --from-git.
  if (plan.mode === "npm") {
    const installed = installedVersion();
    const target = resolveRegistryVersion(plan.spec);
    const verdict = judgeVersionChange({
      installed,
      target,
      pinned: isExactVersion(specVersion(plan.spec)),
      force: !!opts.force,
      spec: plan.spec,
    });
    if (verdict.action === "up-to-date") {
      console.log(`[self-update] ${verdict.message}`);
      return;
    }
    if (verdict.action === "refuse") {
      throw new Error(verdict.message);
    }
    if (installed && target) {
      console.log(
        installed === target
          ? `[self-update] reinstalling ${installed} (same version, explicitly requested)`
          : `[self-update] ${installed} -> ${target}`,
      );
    }
  }

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

  // Leave a note for the server that comes up after the restart.
  //
  // The agent running this command is almost never mid-turn when the
  // restart finally lands (it says "update kicked off" and ends its turn
  // while npm grinds away for 30+ seconds), so the generic
  // "your turn was interrupted" resume path does not cover it -- the one
  // agent guaranteed to care about the update is the one that would never
  // wake back up. The note names this agent's session dir; the next boot
  // consumes it and nudges exactly that agent.
  if (dataDir) {
    const sessionDir = agentSessionDirFromEnv(env);
    const ok = writeRestartNotice(dataDir, {
      requestedAt: new Date().toISOString(),
      ...(sessionDir ? { sessionDir } : {}),
      plan: describePlan(plan),
      unit,
    });
    if (ok && sessionDir) {
      console.log(
        `[self-update] this agent will be resumed automatically after the restart`,
      );
    }
  }

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
    // --no-block is load-bearing, not a nicety. With Type=oneshot,
    // `systemd-run` WAITS for the job to finish by default -- so this
    // command would sit here for the whole install and then get SIGKILLed
    // by the service restart, which is precisely the "agent command dies
    // mid-flight" failure this feature exists to avoid (and it contradicts
    // the "returns immediately" contract the settle delay is built around).
    // A unit-name collision is still reported synchronously, so the
    // "an update is already in progress" error below still works.
    "--no-block",
    "--property=Type=oneshot",
    // The worker outlives this process by design; give it room for a slow
    // registry / git build instead of systemd's 90s default.
    "--property=TimeoutStartSec=1800",
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
