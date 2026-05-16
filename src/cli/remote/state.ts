/** Persistent client-side state for the provisioned remote host.
 *
 *  Lives at `~/.pirouette/host.json` (was `~/.pirouette/ec2.json` before the
 *  provider abstraction). On read we transparently migrate the old filename
 *  forward, so existing deployments don't notice the rename.
 *
 *  Phase 1 ships a single-arm "union": every record has `kind: "ec2"` and
 *  the EC2-specific fields. Phase 2 will add a `byo-host` arm. To avoid
 *  rewriting every existing call site that does `state.instanceId`, the
 *  fields stay on the top-level shape — type-narrowing on `kind` is only
 *  required for byo-host-specific reads when those land.
 *
 *  Records are trivially re-derivable by querying AWS if lost (the instance
 *  and volume are tagged with `pirouette` / `pirouette-data`), but caching
 *  lets us skip the round-trip for common ops.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { defaultUserConfigPath, userConfigPath } from "../../config.js";

/** Provider kinds that can stamp a record. Kept as a string union so the
 *  migration shim can read forward-compatible state files without choking. */
export type ProviderKind = "ec2" | "byo-host";

export interface RemoteState {
  /** Provider that wrote this record. Defaults to `"ec2"` for records
   *  migrated from the old `ec2.json` file (which had no `kind` field).
   *  Per-kind fields below are only meaningful when `kind` matches. */
  kind?: ProviderKind;

  // ---- EC2-kind fields ----
  /** EC2 instance id (i-...). Set once created; persists across stop/start. */
  instanceId?: string;
  /** Current IP of the host (private IP for EC2, IP/alias for byo-host).
   *  Updated on every `pru setup` since stopping a non-Elastic-IP instance
   *  can rotate it. */
  privateIp?: string;
  /** AZ where the instance and volume live. EC2-only. */
  availabilityZone?: string;
  /** Persistent EBS data volume id (vol-...). EC2-only. */
  volumeId?: string;
  /** Local SSH config alias; matches config.ssh.host_alias at creation time. */
  sshHostAlias?: string;

  // ---- byo-host-kind fields ----
  /** SSH alias from ~/.ssh/config (e.g. "gpu"). byo-host. */
  sshAlias?: string;
  /** SSH login user on the remote. byo-host. */
  sshUser?: string;
  /** Mount-point of the persistent volume on the remote (e.g. "/data"). */
  persistentRoot?: string;
  /** Resolved `$HOME` on the remote (after symlink swap). byo-host. */
  homeDir?: string;
  /** Resolved `$PIROUETTE_DATA_DIR` on the remote. byo-host. */
  dataDir?: string;

  // ---- shared ----
  /** ISO timestamp when the host was first provisioned. */
  createdAt?: string;
  /** ISO timestamp of the last state write. */
  updatedAt?: string;
}

/** Canonical state-file path. Derived from the active config path so a
 *  multi-deployment setup (one TOML + one host.json per deployment) Just
 *  Works:
 *
 *    - Default config `~/.pirouette/config.toml`
 *        -> state at `~/.pirouette/host.json`  (historical default; kept
 *           verbatim so existing single-deployment setups don't move
 *           their state file when this code lands)
 *    - Custom config `~/cfgs/ec2.toml`
 *        -> state at `~/cfgs/ec2.host.json`  (stem of config + .host.json,
 *           same directory)
 *    - Explicit `$PIROUETTE_STATE` env var
 *        -> wins outright. Useful when you want a custom state location
 *           independent of the config dir (e.g. ephemeral state on /tmp
 *           for testing).
 */
export function stateFilePath(): string {
  const fromEnv = process.env.PIROUETTE_STATE;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.startsWith("~/")
      ? path.join(homedir(), fromEnv.slice(2))
      : fromEnv;
  }
  const cfg = userConfigPath();
  // Historical default: ~/.pirouette/host.json. Preserved when the active
  // config is the default location so users upgrading from <0.7.0 don't
  // have to migrate their state file.
  if (cfg === defaultUserConfigPath()) {
    return path.join(homedir(), ".pirouette", "host.json");
  }
  // Custom config -> sibling host.json. Replaces the config's extension
  // with `.host.json` so two configs in the same dir don't collide:
  //   ec2.toml      -> ec2.host.json
  //   byo-host.toml -> byo-host.host.json
  const parsed = path.parse(cfg);
  return path.join(parsed.dir, `${parsed.name}.host.json`);
}

/** Directory containing the state file. Created on demand. */
function stateDir(): string {
  return path.dirname(stateFilePath());
}

/** Legacy state-file path: `<state-dir>/ec2.json`. Read forward-compatibly
 *  on first read into the modern `host.json` location; never written.
 *  Only meaningful for the default config (~/.pirouette/) -- custom-config
 *  setups didn't exist before host.json was introduced, so the legacy file
 *  can only be in the default location. */
function legacyStateFilePath(): string {
  return path.join(homedir(), ".pirouette", "ec2.json");
}

/** Read the state file. Migrates `~/.pirouette/ec2.json` → `host.json` on
 *  first access if the new file doesn't exist yet. Missing-file is not an
 *  error (first-run case); returns `{}`. */
export function loadRemoteState(): RemoteState {
  const newPath = stateFilePath();
  const legacyPath = legacyStateFilePath();

  // Migration: legacy file present but new file isn't. Rename in place so
  // subsequent reads/writes hit the new path. We do this on read (not on a
  // dedicated migrate step) so any code path that touches state — `pru
  // status`, `pru setup`, etc. — silently upgrades.
  if (!existsSync(newPath) && existsSync(legacyPath)) {
    try {
      mkdirSync(stateDir(), { recursive: true });
      renameSync(legacyPath, newPath);
    } catch {
      /* best-effort; fall through to read attempt */
    }
  }

  try {
    const raw = readFileSync(newPath, "utf8");
    const parsed = JSON.parse(raw) as RemoteState;
    // Stamp `kind: "ec2"` on records that pre-date the discriminator so
    // callers don't have to handle undefined for legacy-migrated state.
    // Only stamp if the record looks non-empty (has at least one EC2
    // identifier) — pure-empty state stays bare so callers can check
    // "is anything here?" via `Object.keys(state).length === 0` if needed.
    if (parsed.kind === undefined && (parsed.instanceId || parsed.volumeId)) {
      parsed.kind = "ec2";
    }
    return parsed;
  } catch {
    return {};
  }
}

export function saveRemoteState(state: RemoteState): void {
  mkdirSync(stateDir(), { recursive: true });
  const next: RemoteState = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(stateFilePath(), JSON.stringify(next, null, 2));
}

export function updateRemoteState(patch: Partial<RemoteState>): RemoteState {
  const current = loadRemoteState();
  const merged = { ...current, ...patch };
  saveRemoteState(merged);
  return merged;
}

export function clearRemoteState(): void {
  saveRemoteState({});
}
