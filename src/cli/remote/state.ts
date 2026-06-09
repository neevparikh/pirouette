/** Per-host client-side state, one JSON file per host under
 *  `~/.pirouette/state/<host>.json`.
 *
 *  Most of what we need about a host lives in the config (`[hosts.<name>]`),
 *  so this record is intentionally tiny: its job is to record that `pru setup`
 *  has run against a host (so `pru status` can distinguish "configured but
 *  never set up" from "set up", via `hasHostState`). The resolved alias / dirs
 *  are stamped alongside purely for human inspection of the file; commands
 *  read live values from the config, not from here. Records are trivially
 *  re-creatable by re-running `pru setup`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface HostState {
  /** ISO timestamp of the first successful `pru setup`. */
  setupAt?: string;
  /** ISO timestamp of the last state write. */
  updatedAt?: string;
  /** SSH alias recorded at setup time (for display / cleanup). */
  sshAlias?: string;
  /** SSH login user recorded at setup time. */
  user?: string;
  /** Resolved `$PIROUETTE_DATA_DIR` on the remote. */
  dataDir?: string;
  /** Resolved `$HOME` on the remote. */
  homeDir?: string;
}

/** Directory holding all per-host state files. */
function stateDir(): string {
  return path.join(homedir(), ".pirouette", "state");
}

/** State-file path for a named host. */
export function stateFilePath(hostName: string): string {
  return path.join(stateDir(), `${hostName}.json`);
}

/** True if `pru setup` has recorded state for this host. */
export function hasHostState(hostName: string): boolean {
  return existsSync(stateFilePath(hostName));
}

/** Read a host's state. Missing / unparseable / non-object content → `{}`
 *  (treated as "not set up yet"). */
export function loadHostState(hostName: string): HostState {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(hostName), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as HostState;
  } catch {
    return {};
  }
}

export function saveHostState(hostName: string, state: HostState): void {
  mkdirSync(stateDir(), { recursive: true });
  const next: HostState = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(stateFilePath(hostName), JSON.stringify(next, null, 2));
}

export function updateHostState(hostName: string, patch: Partial<HostState>): HostState {
  const merged = { ...loadHostState(hostName), ...patch };
  saveHostState(hostName, merged);
  return merged;
}

/** Delete a host's state file (used by `pru destroy`). */
export function clearHostState(hostName: string): void {
  try {
    rmSync(stateFilePath(hostName), { force: true });
  } catch {
    /* best-effort */
  }
}
