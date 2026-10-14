/** Naming a chat from its first message.
 *
 *  Starting a message with a bare `@ ` in the dashboard means "new chat, you
 *  pick the name". We ask the model the chat is about to run on for a short
 *  kebab-case label, then clean up whatever it says so the result is a
 *  valid `@name` (the dashboard only resolves `[a-zA-Z0-9_-]+` mentions) and
 *  doesn't collide with an existing chat.
 *
 *  Naming must never be the reason a chat fails to start: every failure
 *  (provider error, timeout, an answer that sanitizes to nothing) falls back
 *  to a name derived from the message itself.
 */

/** Longest name we'll hand out. Names end up in worktree paths and branch
 *  names (`agent/<name>-<id>`), so keep them short. */
export const MAX_CHAT_NAME_LENGTH = 40;

/** How much of the first message the namer gets to see. A pasted log or
 *  diff doesn't need to be sent in full to come up with three words. */
export const MAX_NAMING_INPUT_CHARS = 4000;

export const CHAT_NAMING_SYSTEM_PROMPT =
  "You name chat sessions. Given the first message a user sends to a coding agent, " +
  "reply with a short, specific name for the chat: 2 to 5 lowercase words joined by " +
  "hyphens (kebab-case), at most 40 characters, e.g. `fix-login-redirect` or " +
  "`add-csv-export`. Reply with the name only — no quotes, punctuation, or explanation.";

/** Turn arbitrary text into a mention-safe kebab-case name, or "" if there
 *  is nothing usable in it. */
export function sanitizeChatName(raw: string): string {
  // Models sometimes answer "Name: `fix-bug`" or wrap in quotes/backticks,
  // or put the name on the first line followed by commentary. Take the
  // first non-empty line and strip a leading "name:" label.
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const unlabeled = firstLine.replace(/^(chat\s+)?name\s*[:=-]\s*/i, "");

  const slug = unlabeled
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop combining accents: é -> e
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "";
  return truncateAtWord(slug, MAX_CHAT_NAME_LENGTH);
}

/** Cut a kebab-case slug to `max` chars, preferring a word boundary. */
function truncateAtWord(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const lastDash = cut.lastIndexOf("-");
  // Only back off to the dash if that still leaves a reasonable name.
  const trimmed = lastDash >= 8 ? cut.slice(0, lastDash) : cut;
  return trimmed.replace(/-+$/g, "");
}

/** Name to use when the model can't (or won't) give us one: the first few
 *  words of the message, or plain `chat` if those don't survive sanitizing. */
export function fallbackChatName(message: string): string {
  const words = message
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");
  return sanitizeChatName(words) || "chat";
}

/** Make `base` unique among `existing` by appending `-2`, `-3`, … */
export function uniqueChatName(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const stem = base.slice(0, MAX_CHAT_NAME_LENGTH - suffix.length).replace(/-+$/g, "");
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The minimum of pi's AssistantMessage we read. */
export interface NamingReply {
  content: ReadonlyArray<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

/** One-shot completion against the chat's model. Pirouette wires this to
 *  `ModelRuntime.completeSimple`, which handles provider auth. */
export type NamingCompletion = (
  request: {
    systemPrompt: string;
    message: string;
  },
  signal: AbortSignal,
) => Promise<NamingReply>;

export interface GenerateChatNameOptions {
  /** Names already in use; the result is made unique against these. */
  existingNames?: Iterable<string>;
  /** Give up on the model after this long and use the fallback. */
  timeoutMs?: number;
  log?: (message: string) => void;
}

/** Ask the model for a name; never throws. */
export async function generateChatName(
  message: string,
  complete: NamingCompletion,
  opts: GenerateChatNameOptions = {},
): Promise<string> {
  const { existingNames = [], timeoutMs = 15_000, log = () => {} } = opts;
  const input =
    message.length > MAX_NAMING_INPUT_CHARS
      ? `${message.slice(0, MAX_NAMING_INPUT_CHARS)}\n…(truncated)`
      : message;

  let name = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reply = await Promise.race([
      complete({ systemPrompt: CHAT_NAMING_SYSTEM_PROMPT, message: input }, controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error(`timed out after ${timeoutMs}ms`)),
        );
      }),
    ]);
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(reply.errorMessage || `stopReason=${reply.stopReason}`);
    }
    const text = reply.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
    name = sanitizeChatName(text);
    if (!name) log(`model reply had no usable name: ${JSON.stringify(text.slice(0, 200))}`);
  } catch (err) {
    log(`naming failed, using fallback: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  return uniqueChatName(name || fallbackChatName(message), existingNames);
}
