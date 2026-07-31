/** Default timeout for agent `bash` tool calls.
 *
 *  Pi's bash tool takes an optional `timeout` and, when the model omits it,
 *  waits forever. Models omit it almost always — so a `find /`, a `pip
 *  install` against a dead mirror, or a `gh pr checks --watch` on a queue
 *  that never starts will sit in a tool call indefinitely. The agent isn't
 *  stuck in a way anyone can see: the turn is "running", tokens aren't
 *  moving, and the only cure is a human hitting interrupt.
 *
 *  So pirouette gives every bash call a default deadline (30s) and caps how
 *  long an explicit `timeout` may ask for (600s). The work an agent
 *  legitimately needs minutes for — builds, test suites, data pulls — should
 *  be *backgrounded* and polled instead of blocking a tool call, which is
 *  both faster for the agent (it can do other things) and survives
 *  interruption. The system prompt says so up front, and the message on a
 *  timed-out call says so again at the moment it matters.
 *
 *  Configuration (later wins):
 *    - `[defaults.bash_timeout]` in pirouette.toml / ~/.pirouette/config.toml
 *    - `PIROUETTE_BASH_TIMEOUT_SECONDS` / `PIROUETTE_BASH_MAX_TIMEOUT_SECONDS`
 *
 *  Set `default_seconds = 0` to restore pi's "wait forever" behaviour, and
 *  `max_seconds = 0` to let the model ask for any timeout it likes.
 */

import type { InlineExtension, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

/** Deadline applied when the model doesn't ask for one. Thirty seconds is
 *  well past every command an agent runs to *look* at something, and well
 *  short of anything that deserves to block a turn. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 30;

/** Ceiling on an explicit `timeout`. Ten minutes is enough for a slow build
 *  or a test suite the agent wants to sit and watch; past that, backgrounding
 *  is the right shape and the cap is what makes the agent reach for it. */
export const DEFAULT_BASH_MAX_TIMEOUT_SECONDS = 600;

/** `[defaults.bash_timeout]` as written in TOML. All fields optional. */
export interface BashTimeoutConfig {
  default_seconds?: number | string;
  max_seconds?: number | string;
}

export interface BashTimeoutPolicy {
  /** Timeout (seconds) applied when the tool call omits one. 0 = leave pi's
   *  unbounded behaviour alone. */
  defaultSeconds: number;
  /** Largest timeout (seconds) an explicit `timeout` may request; anything
   *  bigger is clamped. 0 = uncapped. */
  maxSeconds: number;
}

/** Policy that changes nothing — pi's own behaviour. */
export const INERT_BASH_TIMEOUT_POLICY: BashTimeoutPolicy = { defaultSeconds: 0, maxSeconds: 0 };

export function isInertBashTimeoutPolicy(policy: BashTimeoutPolicy): boolean {
  return policy.defaultSeconds <= 0 && policy.maxSeconds <= 0;
}

function parseSeconds(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Build the effective policy from `[defaults.bash_timeout]` plus env
 *  overrides. Bad values are ignored (with the reason in `warnings`) rather
 *  than failing server startup — a typo in a timeout must not take the fleet
 *  down. */
export function resolveBashTimeoutPolicy(
  config: BashTimeoutConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): { policy: BashTimeoutPolicy; warnings: string[] } {
  const warnings: string[] = [];

  const read = (
    raw: unknown,
    label: string,
    fallback: number,
  ): number => {
    if (raw === undefined || raw === "") return fallback;
    const parsed = parseSeconds(raw);
    if (parsed === null || parsed < 0) {
      warnings.push(
        `ignoring ${label}=${JSON.stringify(raw)}: expected a non-negative number of seconds`,
      );
      return fallback;
    }
    return Math.round(parsed);
  };

  const defaultSeconds = read(
    env.PIROUETTE_BASH_TIMEOUT_SECONDS ?? config?.default_seconds,
    "bash_timeout.default_seconds",
    DEFAULT_BASH_TIMEOUT_SECONDS,
  );
  let maxSeconds = read(
    env.PIROUETTE_BASH_MAX_TIMEOUT_SECONDS ?? config?.max_seconds,
    "bash_timeout.max_seconds",
    DEFAULT_BASH_MAX_TIMEOUT_SECONDS,
  );

  // A cap below the default would mean "your default is already too long",
  // which is nonsense; raise it rather than silently shortening every call.
  if (maxSeconds > 0 && defaultSeconds > maxSeconds) {
    warnings.push(
      `bash_timeout.max_seconds=${maxSeconds} is below default_seconds=${defaultSeconds}; raising the cap to ${defaultSeconds}`,
    );
    maxSeconds = defaultSeconds;
  }

  return { policy: { defaultSeconds, maxSeconds }, warnings };
}

export interface BashTimeoutDecision {
  /** Timeout the call should run with, in seconds. Undefined = unbounded
   *  (only when the policy is inert or disabled). */
  timeout: number | undefined;
  /** Why the timeout changed, for logging. Null when the call was left
   *  exactly as the model asked for it. */
  change: "defaulted" | "clamped" | null;
}

/** Decide the timeout for one bash call. Pure, so the interesting behaviour
 *  is testable without a live session. */
export function decideBashTimeout(
  policy: BashTimeoutPolicy,
  requested: unknown,
): BashTimeoutDecision {
  const asked = typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : undefined;

  if (asked === undefined) {
    // Includes garbage values (0, NaN, a string): fall back to the default
    // rather than letting pi reject or ignore them.
    if (policy.defaultSeconds > 0) {
      return { timeout: policy.defaultSeconds, change: "defaulted" };
    }
    return { timeout: undefined, change: null };
  }

  if (policy.maxSeconds > 0 && asked > policy.maxSeconds) {
    return { timeout: policy.maxSeconds, change: "clamped" };
  }
  return { timeout: asked, change: null };
}

/** Pi's message on a killed call, e.g. "Command timed out after 30 seconds". */
const PI_TIMEOUT_MESSAGE = /Command timed out after (\d+(?:\.\d+)?) seconds/;

/** The deadline pi reports in a timed-out result, or null if this isn't one. */
export function bashTimeoutSeconds(text: string): number | null {
  const match = PI_TIMEOUT_MESSAGE.exec(text);
  return match ? Number(match[1]) : null;
}

/** What an agent should read the moment one of its commands is killed.
 *  Deliberately concrete: the failure mode we're fixing is an agent that
 *  re-runs the identical command and gets killed again. */
export function bashTimeoutRecoveryHint(policy: BashTimeoutPolicy, seconds?: number): string {
  const cap =
    policy.maxSeconds > 0
      ? `an explicit \`timeout\` (up to ${policy.maxSeconds}s)`
      : "an explicit `timeout`";
  const deadline = seconds ?? policy.defaultSeconds;
  const which =
    seconds !== undefined && seconds !== policy.defaultSeconds ? "" : " default";
  return [
    "",
    `[pirouette] Killed at the ${deadline}s${which} bash timeout. Re-running it unchanged will fail the same way. Pick one:`,
    "  1. Narrow it — search a directory rather than `/`, use `rg --files -g '<glob>'`",
    "     instead of `find`, add `-maxdepth`, or filter earlier in the pipeline.",
    "  2. Background it and poll, which is what long work wants anyway:",
    "       setsid bash -c '<command>' > /tmp/<name>.log 2>&1 & echo started",
    "       # in a later tool call: tail -n 40 /tmp/<name>.log",
    `  3. If you really do need to sit and wait, re-run with ${cap}.`,
  ].join("\n");
}

/** Guidance appended to the system prompt, so the first long command is
 *  backgrounded rather than discovered by being killed. */
export function bashTimeoutGuidance(policy: BashTimeoutPolicy): string | null {
  if (policy.defaultSeconds <= 0 && policy.maxSeconds <= 0) return null;

  const lines: string[] = ["## Shell command timeouts", ""];

  if (policy.defaultSeconds > 0) {
    lines.push(
      `Every \`bash\` tool call runs under a deadline: ${policy.defaultSeconds}s unless you pass an` +
        ` explicit \`timeout\`` +
        (policy.maxSeconds > 0 ? `, and never more than ${policy.maxSeconds}s.` : "."),
      "When it fires the whole process tree is killed and you get the partial output plus an error.",
    );
  } else if (policy.maxSeconds > 0) {
    lines.push(`An explicit \`timeout\` on a \`bash\` call is capped at ${policy.maxSeconds}s.`);
  }

  lines.push(
    "",
    "- Keep commands cheap to run. Scope searches to a directory, prefer `rg --files -g" +
      " '<glob>'` over `find`, and add `-maxdepth`. Walking the whole filesystem will be killed" +
      " long before it finishes.",
    "- Anything that legitimately takes minutes — builds, test suites, installs, data pulls," +
      " `--watch` commands — belongs in the background, not in a blocking tool call:",
    "",
    "    setsid bash -c 'make build' > /tmp/build.log 2>&1 & echo started",
    "    # later, in another tool call:",
    "    tail -n 40 /tmp/build.log",
    "",
    "  `setsid` detaches it, so it survives both the timeout and an interrupted tool call, and" +
      " you stay free to do other work while it runs.",
  );

  if (policy.maxSeconds > 0) {
    lines.push(
      `- Pass \`timeout\` explicitly (up to ${policy.maxSeconds}s) when waiting really is the` +
        " simplest thing, e.g. a test suite you have nothing else to do without.",
    );
  }

  return lines.join("\n");
}

type ResultContent = ToolResultEvent["content"];

/** Append the recovery hint to a timed-out bash result, or return undefined
 *  if this result isn't a timeout (leaving it untouched). Separated out so
 *  the rewriting is testable without an extension runtime. */
export function appendTimeoutHint(
  policy: BashTimeoutPolicy,
  content: ResultContent,
): { content: ResultContent } | undefined {
  let seconds: number | null = null;
  let lastTextIndex = -1;
  content.forEach((part, i) => {
    if (part.type !== "text") return;
    lastTextIndex = i;
    seconds ??= bashTimeoutSeconds(part.text);
  });
  if (seconds === null) return undefined;

  const hint = bashTimeoutRecoveryHint(policy, seconds);
  if (lastTextIndex < 0) return { content: [...content, { type: "text", text: hint }] };
  return {
    content: content.map((part, i) =>
      i === lastTextIndex && part.type === "text" ? { ...part, text: `${part.text}\n${hint}` } : part,
    ),
  };
}

/** The inline pi extension that enforces the policy.
 *
 *  `tool_call` mutates `event.input` in place — pi documents this as the
 *  supported way to patch tool arguments — and `tool_result` recognises pi's
 *  own timeout message and appends the recovery hint to it.
 */
export function createBashTimeoutExtension(
  policy: BashTimeoutPolicy,
  log: (message: string) => void = () => {},
): InlineExtension {
  return {
    name: "bash-timeout",
    factory: (pi) => {
      pi.on("tool_call", (event: ToolCallEvent) => {
        if (event.toolName !== "bash") return;
        const input = event.input as { command?: string; timeout?: number };
        const decision = decideBashTimeout(policy, input.timeout);
        if (decision.change === null) return;
        const before = input.timeout;
        input.timeout = decision.timeout;
        log(
          `[bash-timeout] ${decision.change} ${before ?? "(none)"} -> ${decision.timeout}s: ` +
            `${(input.command ?? "").slice(0, 120)}`,
        );
      });

      pi.on("tool_result", (event: ToolResultEvent) => {
        if (event.toolName !== "bash" || !event.isError) return;
        return appendTimeoutHint(policy, event.content);
      });
    },
  };
}
