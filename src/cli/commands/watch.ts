/** pru watch — have the server wake an agent when something happens.
 *
 *    pru watch pr <pr>          PR checks finish / fail, review or comment,
 *                               merged or closed, merge conflict
 *    pru watch cmd <command>    run a command in the background; wake when
 *                               it exits
 *    pru watch until <command>  re-run a command every --every; wake when
 *                               it exits 0
 *    pru watch timer <duration> wake after a delay
 *    pru watch ls / rm <id>
 *
 *  Run from inside an agent, the watch wakes that agent; `--agent` points
 *  it at another one (a crew agent waking its captain). The wake-up is a
 *  message, queued behind the current turn unless `--steer`. See
 *  src/server/watches.ts for the server side.
 */
import { apiDelete, apiGet, apiPost } from "../api.js";
import { selfAgentRef } from "./handoff.js";

/** Mirrors the server's Watch record (only what the CLI prints). */
interface WatchRecord {
  id: string;
  agentId: string;
  createdBy: string | null;
  kind: "timer" | "cmd" | "until" | "pr";
  note: string | null;
  createdAt: string;
  deadline: string | null;
  command: string | null;
  everyMs: number | null;
  pr: string | null;
  repo: string | null;
  prEvents: string[] | null;
  firedSummary: string | null;
}

export interface WatchCommonOptions {
  agent?: string;
  note?: string;
  steer?: boolean;
  timeout?: string;
  every?: string;
}

/** Same grammar as the server's parseDuration (kept in the CLI so a typo
 *  fails before any request): "90", "90s", "5m", "2h", "1d", "1h30m". */
export function parseDurationArg(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|w)/gy;
  const unit: Record<string, number> = {
    ms: 1, s: 1000, sec: 1000, secs: 1000, m: 60_000, min: 60_000, mins: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, d: 86_400_000, w: 604_800_000,
  };
  let total = 0;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    total += Number(m[1]) * unit[m[2]];
    pos = re.lastIndex;
  }
  if (pos !== s.length || total <= 0) return null;
  return Math.round(total);
}

function fmtDuration(ms: number): string {
  let s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !d) parts.push(`${s}s`);
  return parts.slice(0, 2).join(" ") || "0s";
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function duration(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = parseDurationArg(value);
  if (ms === null) fail(`${flag} ${JSON.stringify(value)} isn't a duration (try 90s, 10m, 2h, 1d)`);
  return ms;
}

/** Target agent and setter: the agent running the command unless
 *  `--agent` says otherwise. Exported for tests. */
export function resolveTarget(
  opts: { agent?: string },
  env: NodeJS.ProcessEnv = process.env,
): { target: string | null; createdBy: string | null } {
  const self = selfAgentRef(env);
  const target = opts.agent && opts.agent !== "self" ? opts.agent : self;
  return { target, createdBy: self };
}

/** Request body for POST /api/agents/:id/watches. Exported for tests. */
export function buildWatchBody(
  kind: WatchRecord["kind"],
  fields: { command?: string; pr?: string; repo?: string; durationMs?: number; prEvents?: string[] },
  opts: WatchCommonOptions,
  createdBy: string | null,
  cwd: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { kind, cwd, mode: opts.steer ? "steer" : "followUp" };
  if (createdBy) body.createdBy = createdBy;
  if (opts.note) body.note = opts.note;
  const everyMs = duration("--every", opts.every);
  if (everyMs !== undefined) body.everyMs = everyMs;
  const timeoutMs = duration("--timeout", opts.timeout);
  if (fields.durationMs !== undefined) body.durationMs = fields.durationMs;
  else if (timeoutMs !== undefined) body.durationMs = timeoutMs;
  if (fields.command !== undefined) body.command = fields.command;
  if (fields.pr !== undefined) body.pr = fields.pr;
  if (fields.repo !== undefined) body.repo = fields.repo;
  if (fields.prEvents !== undefined) body.prEvents = fields.prEvents;
  return body;
}

async function create(
  kind: WatchRecord["kind"],
  fields: Parameters<typeof buildWatchBody>[1],
  opts: WatchCommonOptions,
): Promise<void> {
  const { target, createdBy } = resolveTarget(opts);
  if (!target) {
    fail(
      "this shell isn't inside a pirouette agent (no PI_SESSION_FILE), so there's no " +
        "agent to wake. Pass one: pru watch ... --agent <agent>",
    );
  }
  const body = buildWatchBody(kind, fields, opts, createdBy, process.cwd());
  let w: WatchRecord;
  try {
    w = await apiPost<WatchRecord>(`/api/agents/${target}/watches`, body);
  } catch (err) {
    fail(`could not set the watch: ${err instanceof Error ? err.message : err}`);
  }
  const who = createdBy && w.agentId === createdBy ? "you" : `agent ${w.agentId}`;
  if (w.firedSummary) {
    console.log(`✓ watch ${w.id} fired straight away: ${w.firedSummary}`);
    console.log(`  the details are on their way to ${who} as a message`);
    return;
  }
  console.log(`✓ watch ${w.id} set: ${describe(w)}`);
  const limit = w.deadline
    ? kind === "timer"
      ? `fires in ${fmtDuration(Date.parse(w.deadline) - Date.now())}`
      : `gives up in ${fmtDuration(Date.parse(w.deadline) - Date.now())}`
    : "no time limit";
  console.log(`  wakes ${who} with a message when it fires (${limit})`);
  if (createdBy && w.agentId === createdBy) {
    console.log("  you can end your turn now; cancel with: pru watch rm " + w.id);
  }
}

function describe(w: WatchRecord): string {
  switch (w.kind) {
    case "timer":
      return `timer`;
    case "cmd":
      return `command: ${w.command}`;
    case "until":
      return `until \`${w.command}\` exits 0, checking every ${fmtDuration(w.everyMs ?? 0)}`;
    case "pr": {
      const pr = /^\d+$/.test(w.pr ?? "") ? `${w.repo ? w.repo : ""}#${w.pr}` : w.pr;
      return `PR ${pr} (${(w.prEvents ?? []).join(", ")}), checking every ${fmtDuration(w.everyMs ?? 0)}`;
    }
  }
}

// ---- subcommands --------------------------------------------------------

export async function watchPr(
  pr: string,
  opts: WatchCommonOptions & { repo?: string; on?: string },
): Promise<void> {
  const prEvents = opts.on
    ? opts.on
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  await create("pr", { pr, repo: opts.repo, prEvents }, opts);
}

export async function watchCmd(command: string[], opts: WatchCommonOptions): Promise<void> {
  const text = command.join(" ").trim();
  if (!text) fail("no command given: pru watch cmd '<command>'");
  await create("cmd", { command: text }, opts);
}

export async function watchUntil(command: string[], opts: WatchCommonOptions): Promise<void> {
  const text = command.join(" ").trim();
  if (!text) fail("no command given: pru watch until '<command>'");
  await create("until", { command: text }, opts);
}

export async function watchTimer(delay: string, opts: WatchCommonOptions): Promise<void> {
  const ms = duration("timer", delay)!;
  await create("timer", { durationMs: ms }, opts);
}

export async function watchList(opts: { agent?: string; all?: boolean }): Promise<void> {
  const self = selfAgentRef();
  const agent = opts.agent ?? (opts.all ? undefined : self ?? undefined);
  let watches: WatchRecord[];
  try {
    const res = agent
      ? await apiGet<{ watches: WatchRecord[] }>(`/api/agents/${agent}/watches`)
      : await apiGet<{ watches: WatchRecord[] }>(`/api/watches`);
    watches = res.watches;
  } catch (err) {
    fail(`could not list watches: ${err instanceof Error ? err.message : err}`);
  }
  if (watches.length === 0) {
    console.log(agent ? `No watches on ${agent}.` : "No watches.");
    return;
  }
  for (const w of watches) {
    const state = w.firedSummary
      ? `fired, delivering: ${w.firedSummary}`
      : w.deadline
        ? `${w.kind === "timer" ? "fires" : "gives up"} in ${fmtDuration(Date.parse(w.deadline) - Date.now())}`
        : `running for ${fmtDuration(Date.now() - Date.parse(w.createdAt))}`;
    const forWho = agent ? "" : `  → ${w.agentId}`;
    console.log(`${w.id.padEnd(5)} ${describe(w)}${forWho}`);
    console.log(`      ${state}${w.note ? `; note: ${w.note}` : ""}`);
  }
}

export async function watchRm(ids: string[]): Promise<void> {
  if (ids.length === 0) fail("which watch? pru watch rm <id> (see pru watch ls)");
  let failed = false;
  for (const id of ids) {
    try {
      await apiDelete(`/api/watches/${encodeURIComponent(id)}`);
      console.log(`✓ cancelled ${id}`);
    } catch (err) {
      console.error(`✗ ${id}: ${err instanceof Error ? err.message : err}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}
