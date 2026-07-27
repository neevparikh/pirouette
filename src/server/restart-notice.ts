/** Hand-off note between `pru self-update` and the server that comes up
 *  after the restart.
 *
 *  Why: the update is deliberately violent. `pru self-update` launches a
 *  detached worker that installs a new build and `systemctl restart`s the
 *  service, which SIGTERMs the server and (moments later) SIGKILLs every
 *  bash command its agents were running. The new server's `resumeAll()`
 *  brings agents back and auto-continues the ones that were mid-turn --
 *  but the agent that *asked* for the update is usually NOT mid-turn by
 *  then: it printed "update kicked off", ended its turn, and then sat for
 *  30+ seconds while npm did its thing. Without a note left behind, that
 *  agent comes back parked at `waiting_input` and looks dead, which is
 *  exactly the "I ran self-update and my agent never resumed" symptom.
 *
 *  So `pru self-update` drops a small JSON file in the data dir naming the
 *  session directory it was invoked from (pi exports `PI_SESSION_FILE` into
 *  every tool subprocess, and pirouette gives each agent its own session
 *  dir, so that's an exact agent identity). The next server boot consumes
 *  the file -- read once, then deleted -- and nudges that agent with a
 *  "the update landed, carry on" user turn.
 *
 *  Everything here is best-effort and synchronous: it runs on a CLI path
 *  that is about to be killed by a service restart, so it must not depend
 *  on timers, flushes, or a live server.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** File name inside the data dir. */
export const RESTART_NOTICE_FILE = "self-update-notice.json";

/** Ignore notices older than this. A self-update that fails to install
 *  never restarts the service, so its notice would otherwise sit around
 *  and fire on some unrelated restart hours later. */
export const RESTART_NOTICE_MAX_AGE_MS = 30 * 60 * 1000;

export interface RestartNotice {
  /** ISO timestamp of when `pru self-update` was invoked. */
  requestedAt: string;
  /** Session directory of the agent that triggered the update, derived
   *  from PI_SESSION_FILE. Absent when a human ran the command from a
   *  plain host shell. */
  sessionDir?: string;
  /** Human-readable description of what was installed ("npm install
   *  @neevparikh/pirouette@latest", "git build of ..."). Echoed back to
   *  the agent so it knows what landed. */
  plan?: string;
  /** Transient systemd unit running the worker, for log pointers. */
  unit?: string;
}

export function restartNoticePath(dataDir: string): string {
  return path.join(dataDir, RESTART_NOTICE_FILE);
}

/** The session dir of the agent whose tool call we're running inside, or
 *  undefined outside an agent. pi sets PI_SESSION_FILE to
 *  `<sessionDir>/<timestamp>_<uuid>.jsonl`. */
export function agentSessionDirFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.PI_SESSION_FILE?.trim();
  if (!file) return undefined;
  return path.dirname(path.resolve(file));
}

/** Best-effort write. Never throws: a failure here must not stop an
 *  update, it just means the initiating agent won't get its nudge. */
export function writeRestartNotice(dataDir: string, notice: RestartNotice): boolean {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(restartNoticePath(dataDir), JSON.stringify(notice, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Read + delete the notice (it must fire exactly once). Returns null when
 *  there is no notice, it's unreadable, or it's older than `maxAgeMs`. */
export function consumeRestartNotice(
  dataDir: string,
  now: number = Date.now(),
  maxAgeMs: number = RESTART_NOTICE_MAX_AGE_MS,
): RestartNotice | null {
  const file = restartNoticePath(dataDir);
  if (!existsSync(file)) return null;
  let parsed: RestartNotice | null = null;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as RestartNotice;
  } catch {
    parsed = null;
  }
  try {
    rmSync(file, { force: true });
  } catch {
    // Leaving a stale notice behind is survivable — the age check below
    // stops it from firing forever.
  }
  if (!parsed || typeof parsed !== "object") return null;
  const at = Date.parse(parsed.requestedAt ?? "");
  if (!Number.isFinite(at)) return null;
  if (now - at > maxAgeMs) return null;
  // A clock skew / future-dated notice is still a fresh one; only the
  // "too old" direction is suspicious.
  return parsed;
}
