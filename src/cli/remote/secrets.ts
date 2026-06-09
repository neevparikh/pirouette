/** Push laptop-local secrets onto the remote pirouette host.
 *
 *  Some auth state can't live in a public dotfiles repo, so without an
 *  automated push every fresh host needs the user to manually scp things
 *  over. This module ships the well-known set:
 *
 *    - ~/.pi/agent/auth.json           OAuth refresh + access tokens for pi
 *                                      providers (hawk in particular). Read
 *                                      by pi-hawk-provider on startup for
 *                                      model discovery and token refresh.
 *    - ~/.cache/pi-agent/hawk-access-token   Pre-populated short-TTL JWT cache.
 *    - ~/.pi/agent/pi-cas.json         pi-cas prefs (okta + fast mode); the
 *                                      `sessions` map is stripped before push.
 *    - ~/.aws/config                   Profile + SSO-session definitions.
 *    - ~/.aws/sso/cache/*.json         SSO access tokens (expire ~daily).
 *    - ~/.aws/cli/cache/*.json         CLI cred caches.
 *
 *  Push mechanics: scp directly to `~/<relative>` on the remote, as the SSH
 *  user. No sudo, no chown — we connect as the user that already owns `$HOME`.
 *  On a host whose `$HOME` is symlinked onto the persistent volume, secrets
 *  land on the volume transparently and survive host recreate.
 *
 *  Source files are 600 / private; dirs 700. Best-effort: missing local files
 *  are skipped with a note (setup does not fail if auth.json is absent — you
 *  can `/login hawk` on the remote later).
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { ssh, scp, type RemoteTarget } from "./ssh.js";

/** What we push and where it lands under the remote `$HOME`.
 *
 *  Two flavours, distinguished by `kind`:
 *    - `"file"` (default): scp a single file (hawk `auth.json`, AWS `config`, …).
 *    - `"dir"`:  stage a directory of files (AWS SSO + CLI caches). The dir
 *      push wipes the target by default so stale tokens don't linger. */
export interface SecretFileSpec {
  kind?: "file";
  /** Local file on the laptop (may include `~/`). */
  localPath: string;
  /** Destination path on the remote, relative to `$HOME`. */
  homeRelative: string;
  /** Human-readable label for log lines. */
  label: string;
  /** Optional transform applied to file content before pushing. If it throws,
   *  the file is skipped with a log line rather than aborting the push. */
  transform?: (raw: string) => string;
}

export interface SecretDirSpec {
  kind: "dir";
  /** Local directory on the laptop (may include `~/`). */
  localPath: string;
  /** Destination dir on the remote, relative to `$HOME`. */
  homeRelative: string;
  /** Human-readable label for log lines. */
  label: string;
  /** Optional filename filter. Subdirectories are always ignored (flat dirs). */
  include?: (filename: string) => boolean;
  /** If true (default), wipe the target dir before pushing so removed-locally
   *  files don't linger. False = additive merge. */
  replace?: boolean;
}

export type SecretSpec = SecretFileSpec | SecretDirSpec;

const DEFAULT_SECRETS: SecretSpec[] = [
  // ---- hawk OAuth ----
  {
    localPath: "~/.pi/agent/auth.json",
    homeRelative: ".pi/agent/auth.json",
    label: "hawk OAuth credentials",
  },
  {
    localPath: "~/.cache/pi-agent/hawk-access-token",
    homeRelative: ".cache/pi-agent/hawk-access-token",
    label: "hawk access-token cache",
  },

  // ---- pi-cas-provider prefs ----
  // Persists `fastMode` + `okta` settings so a fresh host starts in the
  // okta-relay mode the laptop is already configured for. We strip the
  // `sessions` map before shipping -- those UUIDs are laptop-side pi-session
  // ids and would be dangling references on the remote.
  {
    localPath: "~/.pi/agent/pi-cas.json",
    homeRelative: ".pi/agent/pi-cas.json",
    label: "pi-cas prefs (okta+fast)",
    transform: (raw) => {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") delete data.sessions;
      return JSON.stringify(data, null, 2);
    },
  },

  // ---- AWS profile + SSO session ----
  {
    localPath: "~/.aws/config",
    homeRelative: ".aws/config",
    label: "AWS config",
  },
  {
    kind: "dir",
    localPath: "~/.aws/sso/cache",
    homeRelative: ".aws/sso/cache",
    label: "AWS SSO cache",
    include: (n) => n.endsWith(".json"),
  },
  {
    kind: "dir",
    localPath: "~/.aws/cli/cache",
    homeRelative: ".aws/cli/cache",
    label: "AWS CLI cache",
    // `session.db` is a CLI-local sqlite activity log, not a credential.
    include: (n) => n.endsWith(".json"),
  },
];

/** Files we consider "primary" -- if missing locally, the user almost
 *  certainly hasn't completed an OAuth flow yet. */
const PRIMARY_AUTH_FILES = new Set(["~/.pi/agent/auth.json"]);

/** Pre-setup check: does the laptop have the primary auth state we plan to
 *  ship? Returns an actionable hint when it's missing. */
export function checkLocalAuth(): { ready: boolean; hint?: string } {
  const missing: string[] = [];
  for (const spec of DEFAULT_SECRETS) {
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
    `  2. After setup, ssh into the host and \`/login hawk\` there\n` +
    `     (\`pru ssh\`, then \`pi\`, then \`/login hawk\`).\n` +
    `Provisioning will continue, but agents using hawk models will fail\n` +
    `until one of the above is done.`;
  return { ready: false, hint };
}

type PushResult = "pushed" | "skipped" | "missing";

/** Push the standard set of laptop-local auth secrets to the remote, via scp
 *  to `~/<relative>` as the SSH user. Called from `pru setup` and
 *  `pru sync --secrets`. Returns a tally for a one-line summary. */
export async function pushSecrets(
  target: RemoteTarget,
  opts: { specs?: SecretSpec[]; quiet?: boolean } = {},
): Promise<{ pushed: number; skipped: number; missing: string[] }> {
  const specs = opts.specs ?? DEFAULT_SECRETS;
  const log = opts.quiet ? () => {} : (msg: string) => console.log(msg);

  let pushed = 0;
  let skipped = 0;
  const missing: string[] = [];

  for (const spec of specs) {
    const result =
      spec.kind === "dir"
        ? await pushDir(target, spec, log)
        : await pushFile(target, spec, log);

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

/** Resolve the actual source path for an scp call. When the spec defines a
 *  `transform`, we read the local file, apply it, and stage the result in a
 *  private tmpdir. Callers MUST invoke `cleanup()` in a finally block.
 *  Returns null if the transform threw (caller treats as skip). */
function materializeSource(
  spec: SecretFileSpec,
  localPath: string,
  log: (m: string) => void,
): { src: string; cleanup: () => void } | null {
  if (!spec.transform) return { src: localPath, cleanup: () => {} };
  let transformed: string;
  try {
    transformed = spec.transform(readFileSync(localPath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  skip  ${spec.label.padEnd(28)} (transform failed: ${msg})`);
    return null;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "pirouette-secret-"));
  const src = path.join(dir, path.basename(spec.homeRelative));
  writeFileSync(src, transformed, { mode: 0o600 });
  return {
    src,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* tmpdir GC will reap it */
      }
    },
  };
}

/** Single file -> ~/<relative> on the remote, as the SSH user. */
async function pushFile(
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

  // `~/...` expands on the remote (both bash and scp expand a leading `~`).
  const remotePath = `~/${spec.homeRelative}`;
  const remoteDir = path.posix.dirname(spec.homeRelative);

  const staged = materializeSource(spec, local, log);
  if (!staged) return "skipped";

  try {
    await ssh(`mkdir -p "$HOME/${remoteDir}" && chmod 700 "$HOME/${remoteDir}"`, { target });
    await scp(staged.src, remotePath, { target });
    await ssh(`chmod 600 "$HOME/${spec.homeRelative}"`, { target });
  } finally {
    staged.cleanup();
  }

  log(`  push  ${spec.label.padEnd(28)} -> ${spec.homeRelative}`);
  return "pushed";
}

/** Directory of files -> ~/<relative>/ on the remote, as the SSH user. */
async function pushDir(
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

  // `~/...` (NOT `$HOME/...`): scp doesn't shell-expand `$HOME`, but both
  // bash and scp expand a leading `~`. Left unquoted (homeRelative is
  // config-controlled and whitespace-free for our specs).
  const remoteDir = `~/${spec.homeRelative}`;
  const setup =
    spec.replace === false
      ? `mkdir -p ${remoteDir} && chmod 700 ${remoteDir}`
      : `rm -rf ${remoteDir} && mkdir -p ${remoteDir} && chmod 700 ${remoteDir}`;
  await ssh(setup, { target });

  for (const f of files) {
    await scp(path.join(local, f), `${remoteDir}/${f}`, { target });
  }

  await ssh(`find ${remoteDir} -type f -exec chmod 600 {} \\;`, { target });

  log(
    `  push  ${spec.label.padEnd(28)} -> ${spec.homeRelative}/ ` +
      `(${files.length} file${files.length === 1 ? "" : "s"})`,
  );
  return "pushed";
}

/** Enumerate the flat list of files in `localDir` to push. Skip
 *  subdirectories and zero-byte files (would ship a broken cred). */
function listPushableFiles(localDir: string, include?: (name: string) => boolean): string[] {
  return readdirSync(localDir).filter((name) => {
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

function expandHome(p: string): string {
  if (!p.startsWith("~/")) return p;
  const home = process.env.HOME ?? "";
  return path.join(home, p.slice(2));
}
