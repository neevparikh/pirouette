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

/** Provider kinds that can stamp a record. Extended in Phase 2 to include
 *  `"byo-host"`. Kept as a string union (not just `"ec2"`) so the migration
 *  shim can read forward-compatible state files without choking. */
export type ProviderKind = "ec2";

export interface RemoteState {
  /** Provider that wrote this record. Defaults to `"ec2"` for records
   *  migrated from the old `ec2.json` file (which had no `kind` field).
   *  Phase 2 promotes this into a discriminator for a proper union. */
  kind?: ProviderKind;
  /** EC2 instance id (i-...). Set once created; persists across stop/start. */
  instanceId?: string;
  /** Current private IP of the instance. Updated on every `pru setup` since
   *  stopping a non-Elastic-IP instance can rotate it. */
  privateIp?: string;
  /** AZ where the instance and volume live. Fixed once created (EBS volumes
   *  can't move AZs; instance launch must match). */
  availabilityZone?: string;
  /** Persistent EBS data volume id (vol-...). Survives instance termination
   *  unless the user passes `--delete-volume` to `pru destroy`. */
  volumeId?: string;
  /** Local SSH config alias; matches config.ssh.host_alias at creation time. */
  sshHostAlias?: string;
  /** ISO timestamp when the host was first provisioned. */
  createdAt?: string;
  /** ISO timestamp of the last state write. */
  updatedAt?: string;
}

function stateDir(): string {
  return path.join(homedir(), ".pirouette");
}

/** Canonical state-file path. */
export function stateFilePath(): string {
  return path.join(stateDir(), "host.json");
}

/** Legacy state-file path. Read forward-compatibly; never written. Will be
 *  removed in a future release once the migration window closes. */
function legacyStateFilePath(): string {
  return path.join(stateDir(), "ec2.json");
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
