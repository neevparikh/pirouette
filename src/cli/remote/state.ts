/** Persistent client-side state for the remote EC2 instance.
 *
 *  Lives at `~/.pirouette/ec2.json`. Holds the instance id, EBS volume id,
 *  current private IP, AZ, and the local SSH config alias. Survives across
 *  CLI invocations and across `pru teardown`/`setup` cycles.
 *
 *  This file is trivially re-derivable by querying AWS if lost (the instance
 *  and volume are tagged with `pirouette` / `pirouette-data`), but caching
 *  lets us skip the round-trip for common ops.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface RemoteState {
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
  /** ISO timestamp when the instance was first launched. */
  createdAt?: string;
  /** ISO timestamp of the last state write. */
  updatedAt?: string;
}

function stateDir(): string {
  return path.join(homedir(), ".pirouette");
}

export function stateFilePath(): string {
  return path.join(stateDir(), "ec2.json");
}

export function loadRemoteState(): RemoteState {
  try {
    const raw = readFileSync(stateFilePath(), "utf8");
    return JSON.parse(raw) as RemoteState;
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
