/** Push laptop-local secrets into the container's persistent home.
 *
 *  This is "step A" of the auth-on-first-boot story (see docs / chat log).
 *  Some auth state can't live in the public dotfiles repo, so without an
 *  automated push every fresh container needs the user to manually scp
 *  things over. This module fixes that for the well-known set:
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
 *  Mechanics: the container bind-mounts `/var/lib/pirouette/home-neev`
 *  (host) to `/home/neev` (container). We scp to the host path and the
 *  files appear inside the container instantly. No docker exec required.
 *
 *  Both source files are 600 / private. We `chmod 600` after scp so the
 *  bind-mount preserves the right perms.
 *
 *  This is best-effort: missing local files are skipped with a note.
 *  Setup does not fail if auth.json isn't on the laptop -- you can
 *  `/login hawk` inside the container later. */

import { existsSync, statSync } from "node:fs";
import path from "node:path";

import type { PirouetteConfig } from "../../config.js";
import { ssh, scp, currentTarget } from "./ssh.js";

/** What we push and where it lands inside the container's bind-mounted
 *  home. Keep paths in sync with the dotfiles + entrypoint conventions:
 *  the container side is `$HOME/...`, and the host side is whatever the
 *  bind-mount source is (default `/var/lib/pirouette/home-neev`). */
export interface SecretSpec {
  /** Local file on the laptop (may include `~/`). */
  localPath: string;
  /** Path inside the container, relative to `$HOME`. We use this to derive
   *  the host bind-mount path for scp. */
  containerHomeRelative: string;
  /** Human-readable label for log lines. */
  label: string;
}

const DEFAULT_SECRETS: SecretSpec[] = [
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
];

/** Files we consider "primary" — if these are missing locally, the user
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
 *      pirouette runs natively on the remote (not in a separate container).
 */
export type PushMode = "ec2-bindmount" | "plain-ssh";

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
    target?: { user: string; host: string; keyPath?: string; useAlias?: boolean };
  } = {},
): Promise<{ pushed: number; skipped: number; missing: string[] }> {
  const specs = opts.specs ?? DEFAULT_SECRETS;
  const log = opts.quiet ? () => {} : (msg: string) => console.log(msg);
  const mode: PushMode = opts.mode ?? "ec2-bindmount";

  let pushed = 0;
  let skipped = 0;
  const missing: string[] = [];

  for (const spec of specs) {
    const local = expandHome(spec.localPath);
    if (!existsSync(local)) {
      log(`  skip  ${spec.label.padEnd(28)} (no ${spec.localPath} on laptop)`);
      missing.push(spec.localPath);
      skipped += 1;
      continue;
    }

    // Validate it's a regular file before scp -- a stray symlink to a
    // dead target would scp-as-zero-bytes and then we'd silently ship a
    // broken auth state.
    const st = statSync(local);
    if (!st.isFile() || st.size === 0) {
      log(`  skip  ${spec.label.padEnd(28)} (${spec.localPath} is empty / not a regular file)`);
      skipped += 1;
      continue;
    }

    if (mode === "ec2-bindmount") {
      await pushOneToBindMount(cfg, spec, local);
    } else {
      if (!opts.target) {
        throw new Error("plain-ssh push mode requires opts.target");
      }
      await pushOneViaPlainSsh(opts.target, spec, local);
    }

    log(`  push  ${spec.label.padEnd(28)} -> ${spec.containerHomeRelative}`);
    pushed += 1;
  }

  return { pushed, skipped, missing };
}

/** ec2-bindmount mode: scp to host's bind-mount path, chown to uid 1000. */
async function pushOneToBindMount(
  cfg: PirouetteConfig,
  spec: SecretSpec,
  local: string,
): Promise<void> {
  const target = currentTarget(cfg);
  const hostHome = hostHomeBindMount();
  const remoteHostPath = path.posix.join(hostHome, spec.containerHomeRelative);
  const remoteDir = path.posix.dirname(remoteHostPath);
  // First path segment under $HOME -- e.g. ".pi" for ".pi/agent/auth.json".
  // sudo mkdir -p creates ALL intermediate dirs as root, so chowning just
  // the leaf leaves ".pi" itself root-owned (mode 755). The container user
  // can read+traverse but can't create siblings under ".pi" -- pi-agent
  // breaks. We chown -R the top-level segment to fix every level at once.
  const topSegment = spec.containerHomeRelative.split("/")[0];
  const topAncestor = path.posix.join(hostHome, topSegment);

  await ssh(
    `sudo mkdir -p ${remoteDir} && sudo chown -R 1000:1000 ${topAncestor} && sudo chmod 700 ${remoteDir}`,
    { target },
  );
  await scp(local, remoteHostPath, { target });
  await ssh(
    `sudo chown 1000:1000 ${remoteHostPath} && sudo chmod 600 ${remoteHostPath}`,
    { target },
  );
}

/** plain-ssh mode: scp as the SSH user directly into $HOME/<relative>.
 *  No sudo, no chown -- the file lands owned by the connecting user, which
 *  is the same user the pirouette server runs as. After byo-host's home
 *  swap, $HOME is a symlink onto the persistent volume, so files written
 *  here automatically persist across pod/instance recreates. */
async function pushOneViaPlainSsh(
  target: { user: string; host: string; keyPath?: string; useAlias?: boolean },
  spec: SecretSpec,
  local: string,
): Promise<void> {
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
}
