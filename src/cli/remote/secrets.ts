/** Push laptop-local secrets onto the remote pirouette host.
 *
 *  Some auth state can't live in the public dotfiles repo, so without an
 *  automated push every fresh container/devpod needs the user to manually
 *  scp things over. This module fixes that for the well-known set:
 *
 *    - ~/.pi/agent/auth.json           OAuth refresh + access tokens for
 *                                      pi providers (hawk in particular).
 *                                      Read by pi-hawk-provider on startup
 *                                      for model discovery and runtime
 *                                      token refresh.
 *
 *    - ~/.cache/pi-agent/hawk-access-token
 *                                      Pre-populated short-TTL JWT cache.
 *                                      Strictly belt-and-suspenders -- once
 *                                      auth.json is in place the cache
 *                                      script regenerates it from the
 *                                      refresh token. We push it anyway
 *                                      so the very first request after
 *                                      setup doesn't have to do an OAuth
 *                                      roundtrip.
 *
 *    - ~/.aws/config                   Profile + SSO-session definitions.
 *                                      Mostly static; tracks laptop edits.
 *
 *    - ~/.aws/sso/cache/*.json         SSO access tokens (the part that
 *    - ~/.aws/cli/cache/*.json         expires every ~8h). Refresh by
 *                                      running `aws sso login` on the
 *                                      laptop and then `pru sync --secrets`
 *                                      again. `session.db` is excluded by
 *                                      the include filter -- it's a CLI-
 *                                      local sqlite activity log, not a
 *                                      credential, and copying it would
 *                                      confuse the container CLI's own
 *                                      bookkeeping.
 *
 *  Push mechanics depend on the provider's `mode`:
 *
 *    - `ec2-bindmount`: the container bind-mounts
 *      `/var/lib/pirouette/home-<user>` (host) to `/home/<user>` (container).
 *      We scp to the host bind-mount path under sudo and chown 1000:1000 so
 *      the container's uid-1000 user reads through.
 *
 *    - `plain-ssh`: scp directly to `~/<relative>` on the remote as the
 *      SSH user. No sudo, no chown -- we connect as the user that already
 *      owns the file. After byo-host's whole-home symlink swap, `~/...`
 *      resolves onto the persistent volume transparently, so secrets land
 *      on `/data/home/<user>/...` and survive pod recreate.
 *
 *  Source files are 600 / private; dirs are 700. We chmod accordingly
 *  after the push so the bind-mount / persistent home preserves perms.
 *
 *  This is best-effort: missing local files are skipped with a note.
 *  Setup does not fail if auth.json isn't on the laptop -- you can
 *  `/login hawk` inside the container later. AWS is similarly soft: if
 *  you've never `aws sso login`'d, the SSO cache dir won't exist and
 *  we'll just skip it. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { PirouetteConfig } from "../../config.js";
import { ssh, scp, currentTarget, type RemoteTarget } from "./ssh.js";

/** What we push and where it lands inside the container's `$HOME`. Keep
 *  paths in sync with the dotfiles + entrypoint conventions: the container
 *  side is `$HOME/...`, and on EC2 the host bind-mount source is whatever
 *  the entrypoint sets (default `/var/lib/pirouette/home-<user>`).
 *
 *  Two flavours, distinguished by `kind`:
 *    - `"file"` (default): scp a single file. Used for hawk `auth.json`,
 *      AWS `config`, etc. -- small JSON / token blobs.
 *    - `"dir"`:  stage a directory of files. Used for AWS SSO + CLI
 *      caches, which contain N `<hash>.json` files. The dir push wipes
 *      the target by default so stale tokens don't linger across pushes. */
export interface SecretFileSpec {
  kind?: "file";
  /** Local file on the laptop (may include `~/`). */
  localPath: string;
  /** Path inside the container, relative to `$HOME`. We use this to derive
   *  the host bind-mount path for scp. */
  containerHomeRelative: string;
  /** Human-readable label for log lines. */
  label: string;
}

export interface SecretDirSpec {
  kind: "dir";
  /** Local directory on the laptop (may include `~/`). */
  localPath: string;
  /** Directory path inside the container, relative to `$HOME`. */
  containerHomeRelative: string;
  /** Human-readable label for log lines. */
  label: string;
  /** Optional filename filter. Only files in `localPath` whose name
   *  matches are pushed. Subdirectories are always ignored (we only do
   *  flat dirs -- SSO/CLI cache is flat). */
  include?: (filename: string) => boolean;
  /** If true (default), wipe the target dir on the container before
   *  pushing so removed-locally files don't linger. False = additive
   *  merge. We use `true` for AWS caches so expired token files get
   *  cleared instead of shadowing fresh ones. */
  replace?: boolean;
}

export type SecretSpec = SecretFileSpec | SecretDirSpec;

const DEFAULT_SECRETS: SecretSpec[] = [
  // ---- hawk OAuth ----
  {
    localPath: "~/.pi/agent/auth.json",
    containerHomeRelative: ".pi/agent/auth.json",
    label: "hawk OAuth credentials",
  },
  {
    localPath: "~/.cache/pi-agent/hawk-access-token",
    containerHomeRelative: ".cache/pi-agent/hawk-access-token",
    label: "hawk access-token cache",
  },

  // ---- AWS profile + SSO session ----
  // Lets agents on the remote hit S3/STS with the same credentials the
  // laptop has. Push after each `aws sso login` to refresh the cache JSONs
  // (they expire roughly daily). Re-pushing config is harmless even if it
  // hasn't changed.
  {
    localPath: "~/.aws/config",
    containerHomeRelative: ".aws/config",
    label: "AWS config",
  },
  {
    kind: "dir",
    localPath: "~/.aws/sso/cache",
    containerHomeRelative: ".aws/sso/cache",
    label: "AWS SSO cache",
    include: (n) => n.endsWith(".json"),
  },
  {
    kind: "dir",
    localPath: "~/.aws/cli/cache",
    containerHomeRelative: ".aws/cli/cache",
    label: "AWS CLI cache",
    // `session.db` is a CLI-local sqlite activity log, not a credential
    // -- copying it across machines would confuse the container CLI's
    // own bookkeeping. Only ship the `<hash>.json` cred caches.
    include: (n) => n.endsWith(".json"),
  },
];

/** Files we consider "primary" -- if these are missing locally, the user
 *  almost certainly hasn't completed an OAuth flow yet and the container's
 *  hawk-provider will fail model discovery. We surface a clear hint at
 *  setup time so they don't discover this only when an agent errors. */
const PRIMARY_AUTH_FILES = new Set(["~/.pi/agent/auth.json"]);

/** Pre-setup check: does the laptop have the primary auth state we plan to
 *  ship? Returns an actionable hint when it's missing. Used by `pru setup`
 *  to fail loudly *before* spending five minutes provisioning, instead of
 *  silently skipping the push and emitting a confusing model error later. */
export function checkLocalAuth(): { ready: boolean; hint?: string } {
  const missing: string[] = [];
  for (const spec of DEFAULT_SECRETS) {
    // PRIMARY_AUTH_FILES are all single files; dir specs (AWS caches) are
    // never "primary" -- their absence doesn't block setup, just means
    // agents won't have AWS until you run `pru sync --secrets` after an
    // `aws sso login`.
    if (spec.kind === "dir") continue;
    if (!PRIMARY_AUTH_FILES.has(spec.localPath)) continue;
    const local = expandHome(spec.localPath);
    if (!existsSync(local)) {
      missing.push(spec.localPath);
      continue;
    }
    try {
      if (statSync(local).size === 0) missing.push(spec.localPath);
    } catch {
      missing.push(spec.localPath);
    }
  }
  if (missing.length === 0) return { ready: true };
  const hint =
    `No local auth state found (${missing.join(", ")}).\n` +
    `Either:\n` +
    `  1. Run \`pi\` locally and \`/login hawk\` to authenticate this laptop.\n` +
    `  2. After setup, ssh into the container and \`/login hawk\` there\n` +
    `     (\`pru ssh\`, then \`pi\`, then \`/login hawk\`).\n` +
    `Provisioning will continue, but agents using hawk models will fail\n` +
    `until one of the above is done.`;
  return { ready: false, hint };
}

function expandHome(p: string): string {
  if (!p.startsWith("~/")) return p;
  const home = process.env.HOME ?? "";
  return path.join(home, p.slice(2));
}

/** Bind-mount source on the host for the container's `$HOME`.
 *  Mirrors the path the EC2 user-data script sets up. If you ever change
 *  it there, change it here too. */
function hostHomeBindMount(): string {
  return "/var/lib/pirouette/home-neev";
}

/** Push mode controls scp target + ownership fix-ups.
 *
 *    - `ec2-bindmount`: scp to the host's bind-mount path
 *      (`/var/lib/pirouette/home-<user>/...`), then sudo chown 1000:1000.
 *      This is what `pru setup` on the EC2 provider has always done; the
 *      container's uid-1000 user reads through the bind-mount.
 *
 *    - `plain-ssh`: scp directly to `$HOME/...` on the remote, as the SSH
 *      user. No sudo, no chown -- we connect as the user that already
 *      owns the file. Used by byo-host and any future provider where
 *      pirouette runs natively on the remote (not in a separate container). */
export type PushMode = "ec2-bindmount" | "plain-ssh";

type PushResult = "pushed" | "skipped" | "missing";

/** Push the standard set of laptop-local auth secrets to the remote.
 *  Called from `pru setup` (via the provider) and `pru sync --secrets`.
 *  Returns a tally so the caller can log a one-line summary. */
export async function pushSecrets(
  cfg: PirouetteConfig,
  opts: {
    specs?: SecretSpec[];
    quiet?: boolean;
    mode?: PushMode;
    /** Required for `plain-ssh` mode. SSH target to scp into. For
     *  `ec2-bindmount` we keep using `currentTarget(cfg)` to talk to the
     *  EC2 host. */
    target?: RemoteTarget;
  } = {},
): Promise<{ pushed: number; skipped: number; missing: string[] }> {
  const specs = opts.specs ?? DEFAULT_SECRETS;
  const log = opts.quiet ? () => {} : (msg: string) => console.log(msg);
  const mode: PushMode = opts.mode ?? "ec2-bindmount";

  if (mode === "plain-ssh" && !opts.target) {
    throw new Error("plain-ssh push mode requires opts.target");
  }

  let pushed = 0;
  let skipped = 0;
  const missing: string[] = [];

  for (const spec of specs) {
    const result =
      spec.kind === "dir"
        ? mode === "ec2-bindmount"
          ? await pushDirToBindMount(cfg, spec, log)
          : await pushDirViaPlainSsh(opts.target!, spec, log)
        : mode === "ec2-bindmount"
          ? await pushFileToBindMount(cfg, spec, log)
          : await pushFileViaPlainSsh(opts.target!, spec, log);

    if (result === "pushed") pushed += 1;
    else if (result === "missing") {
      missing.push(spec.localPath);
      skipped += 1;
    } else {
      skipped += 1;
    }
  }

  return { pushed, skipped, missing };
}

// ---- ec2-bindmount mode -----------------------------------------------------

/** Single file -> host bind-mount path, chown to uid 1000. */
async function pushFileToBindMount(
  cfg: PirouetteConfig,
  spec: SecretFileSpec,
  log: (m: string) => void,
): Promise<PushResult> {
  const local = expandHome(spec.localPath);
  if (!existsSync(local)) {
    log(`  skip  ${spec.label.padEnd(28)} (no ${spec.localPath} on laptop)`);
    return "missing";
  }
  const st = statSync(local);
  if (!st.isFile() || st.size === 0) {
    log(`  skip  ${spec.label.padEnd(28)} (${spec.localPath} is empty / not a regular file)`);
    return "skipped";
  }

  const target = currentTarget(cfg);
  const hostHome = hostHomeBindMount();
  const remoteHostPath = path.posix.join(hostHome, spec.containerHomeRelative);
  const remoteDir = path.posix.dirname(remoteHostPath);
  const topAncestor = topAncestorPath(hostHome, spec.containerHomeRelative);

  // First path segment under $HOME -- e.g. ".pi" for ".pi/agent/auth.json".
  // sudo mkdir -p creates ALL intermediate dirs as root, so chowning just
  // the leaf leaves ".pi" itself root-owned (mode 755). The container user
  // can read+traverse but can't create siblings under ".pi" -- pi-agent
  // breaks. We chown -R the top-level segment to fix every level at once.
  await ssh(
    `sudo mkdir -p ${remoteDir} && sudo chown -R 1000:1000 ${topAncestor} && sudo chmod 700 ${remoteDir}`,
    { target },
  );
  await scp(local, remoteHostPath, { target });
  // scp lands as ubuntu:ubuntu on host -- fix to uid 1000 + 0600 so
  // the container user can read but nobody else.
  await ssh(
    `sudo chown 1000:1000 ${remoteHostPath} && sudo chmod 600 ${remoteHostPath}`,
    { target },
  );

  log(`  push  ${spec.label.padEnd(28)} -> ${spec.containerHomeRelative}`);
  return "pushed";
}

/** Directory of files -> host bind-mount, staged then moved under sudo. */
async function pushDirToBindMount(
  cfg: PirouetteConfig,
  spec: SecretDirSpec,
  log: (m: string) => void,
): Promise<PushResult> {
  const local = expandHome(spec.localPath);
  if (!existsSync(local) || !statSync(local).isDirectory()) {
    log(`  skip  ${spec.label.padEnd(28)} (no ${spec.localPath} on laptop)`);
    return "missing";
  }

  const files = listPushableFiles(local, spec.include);
  if (files.length === 0) {
    log(`  skip  ${spec.label.padEnd(28)} (${spec.localPath} has nothing to push)`);
    return "skipped";
  }

  const target = currentTarget(cfg);
  const hostHome = hostHomeBindMount();
  const remoteHostDir = path.posix.join(hostHome, spec.containerHomeRelative);
  const topAncestor = topAncestorPath(hostHome, spec.containerHomeRelative);
  // Stage to a writable user-owned tmp dir on the host so scp doesn't
  // need sudo; then move into the bind-mount under sudo. Random suffix
  // so concurrent pushes don't collide.
  const stage = `/tmp/pirouette-secret-${randomUUID()}`;

  await ssh(`mkdir -p ${stage}`, { target });
  try {
    for (const f of files) {
      await scp(path.join(local, f), `${stage}/${f}`, { target });
    }
    // Replace semantics: wipe the target dir contents (not the dir itself,
    // so other state alongside it isn't disturbed). `replace !== false`
    // defaults true; setting it false skips the rm.
    const wipe =
      spec.replace === false
        ? `sudo mkdir -p ${remoteHostDir}`
        : `sudo rm -rf ${remoteHostDir} && sudo mkdir -p ${remoteHostDir}`;
    // mv staged files into place, fix ownership/perms in one ssh round-trip.
    // chmod 700 on the dir, 600 on each file (matches `aws sso login`'s
    // default for these caches).
    await ssh(
      [
        wipe,
        `sudo mv ${stage}/* ${remoteHostDir}/`,
        `sudo chown -R 1000:1000 ${topAncestor}`,
        `sudo chmod 700 ${remoteHostDir}`,
        `sudo find ${remoteHostDir} -type f -exec chmod 600 {} \\;`,
      ].join(" && "),
      { target },
    );
  } finally {
    // Best-effort cleanup of the stage dir; ignore errors so a failure
    // here doesn't mask the real one above.
    await ssh(`rm -rf ${stage}`, { target }).catch(() => undefined);
  }

  log(
    `  push  ${spec.label.padEnd(28)} -> ${spec.containerHomeRelative}/ ` +
      `(${files.length} file${files.length === 1 ? "" : "s"})`,
  );
  return "pushed";
}

// ---- plain-ssh mode ---------------------------------------------------------

/** Single file -> ~/<relative> on the remote, as the SSH user. */
async function pushFileViaPlainSsh(
  target: RemoteTarget,
  spec: SecretFileSpec,
  log: (m: string) => void,
): Promise<PushResult> {
  const local = expandHome(spec.localPath);
  if (!existsSync(local)) {
    log(`  skip  ${spec.label.padEnd(28)} (no ${spec.localPath} on laptop)`);
    return "missing";
  }
  const st = statSync(local);
  if (!st.isFile() || st.size === 0) {
    log(`  skip  ${spec.label.padEnd(28)} (${spec.localPath} is empty / not a regular file)`);
    return "skipped";
  }

  // Path on the remote, resolved through $HOME (which on byo-host is the
  // symlink onto the PVC). We pass it as `~/...` to let the remote shell
  // expand -- avoids hard-coding the absolute home path on the laptop.
  const remotePath = `~/${spec.containerHomeRelative}`;
  const remoteDir = path.posix.dirname(spec.containerHomeRelative);

  // Ensure parent dir exists with 700 perms. Quoted so `~` expands but the
  // path itself doesn't word-split.
  await ssh(`mkdir -p "$HOME/${remoteDir}" && chmod 700 "$HOME/${remoteDir}"`, { target });
  await scp(local, remotePath, { target });
  await ssh(`chmod 600 "$HOME/${spec.containerHomeRelative}"`, { target });

  log(`  push  ${spec.label.padEnd(28)} -> ${spec.containerHomeRelative}`);
  return "pushed";
}

/** Directory of files -> ~/<relative>/ on the remote, as the SSH user.
 *  Simpler than the bind-mount variant: no sudo, no staging dir, no chown
 *  -- we connect as the user that already owns `~`. */
async function pushDirViaPlainSsh(
  target: RemoteTarget,
  spec: SecretDirSpec,
  log: (m: string) => void,
): Promise<PushResult> {
  const local = expandHome(spec.localPath);
  if (!existsSync(local) || !statSync(local).isDirectory()) {
    log(`  skip  ${spec.label.padEnd(28)} (no ${spec.localPath} on laptop)`);
    return "missing";
  }

  const files = listPushableFiles(local, spec.include);
  if (files.length === 0) {
    log(`  skip  ${spec.label.padEnd(28)} (${spec.localPath} has nothing to push)`);
    return "skipped";
  }

  // Use `~/...` (NOT `$HOME/...`). scp does NOT shell-expand `$HOME` on
  // the remote -- the path is passed literally and lands as a directory
  // called "$HOME". scp DOES expand `~` as an OpenSSH-specific feature.
  // Both bash (for our `ssh` commands) and scp expand `~` consistently,
  // so a single form works for both. (`~` inside double-quotes does NOT
  // expand, so we deliberately leave the path unquoted -- safe because
  // `containerHomeRelative` is config-controlled and never contains
  // whitespace for our standard secret specs.)
  const remoteDir = `~/${spec.containerHomeRelative}`;
  const setup =
    spec.replace === false
      ? `mkdir -p ${remoteDir} && chmod 700 ${remoteDir}`
      : `rm -rf ${remoteDir} && mkdir -p ${remoteDir} && chmod 700 ${remoteDir}`;
  await ssh(setup, { target });

  for (const f of files) {
    await scp(path.join(local, f), `${remoteDir}/${f}`, { target });
  }

  // chmod 600 every pushed file (matches aws sso login's default).
  await ssh(`find ${remoteDir} -type f -exec chmod 600 {} \\;`, { target });

  log(
    `  push  ${spec.label.padEnd(28)} -> ${spec.containerHomeRelative}/ ` +
      `(${files.length} file${files.length === 1 ? "" : "s"})`,
  );
  return "pushed";
}

// ---- helpers ---------------------------------------------------------------

/** Enumerate the flat list of files in `localDir` to push. Skip
 *  subdirectories (we don't recurse -- the AWS cache dirs are flat) and
 *  zero-byte files (would silently ship a broken cred). */
function listPushableFiles(localDir: string, include?: (name: string) => boolean): string[] {
  const allEntries = readdirSync(localDir);
  return allEntries.filter((name) => {
    const full = path.join(localDir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      return false;
    }
    if (!st.isFile() || st.size === 0) return false;
    return include ? include(name) : true;
  });
}

/** First path segment under $HOME, joined onto the host home prefix.
 *  E.g. for ".aws/sso/cache" → "/var/lib/pirouette/home-neev/.aws".
 *  `sudo chown -R 1000:1000 <topAncestor>` fixes the whole tree at once
 *  (matters because `sudo mkdir -p` creates intermediates as root).
 *  Only used by the `ec2-bindmount` paths; `plain-ssh` doesn't need
 *  ancestor chowning because everything lands under `$HOME` already. */
function topAncestorPath(hostHome: string, containerHomeRelative: string): string {
  const topSegment = containerHomeRelative.split("/")[0];
  return path.posix.join(hostHome, topSegment);
}
