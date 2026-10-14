/**
 * Naming a chat from its first message (the dashboard's bare `@ `).
 *
 * The name has to be a usable `@mention` (`[a-zA-Z0-9_-]+`), unique among
 * existing chats, and — above all — naming must never stop a chat from
 * starting, so every model failure falls back to a name built from the
 * message.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CHAT_NAMING_SYSTEM_PROMPT,
  MAX_CHAT_NAME_LENGTH,
  MAX_NAMING_INPUT_CHARS,
  fallbackChatName,
  generateChatName,
  sanitizeChatName,
  uniqueChatName,
  type NamingReply,
} from "../chat-naming.js";

const reply = (text: string, extra: Partial<NamingReply> = {}): NamingReply => ({
  content: [{ type: "text", text }],
  stopReason: "stop",
  ...extra,
});

describe("sanitizeChatName", () => {
  it.each([
    ["fix-login-redirect", "fix-login-redirect"],
    ["`Fix Login Redirect`", "fix-login-redirect"],
    ['"add_csv export!"', "add-csv-export"],
    ["Name: tidy-readme", "tidy-readme"],
    ["refactor-auth\n\nThis name reflects the request.", "refactor-auth"],
    ["Café menü", "cafe-menu"],
    ["  --- ", ""],
    ["", ""],
  ])("%j -> %j", (raw, expected) => {
    expect(sanitizeChatName(raw)).toBe(expected);
  });

  it("caps the length, preferring a word boundary", () => {
    const name = sanitizeChatName(
      "investigate-the-intermittent-websocket-reconnect-failure-on-mobile",
    );
    expect(name.length).toBeLessThanOrEqual(MAX_CHAT_NAME_LENGTH);
    expect(name).toBe("investigate-the-intermittent-websocket");
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("fallbackChatName", () => {
  it("uses the first few words of the message", () => {
    expect(fallbackChatName("Please fix the flaky login test in CI today")).toBe(
      "please-fix-the-flaky-login",
    );
  });

  it("falls back to `chat` when nothing survives", () => {
    expect(fallbackChatName("🙂🙂 ???")).toBe("chat");
  });
});

describe("uniqueChatName", () => {
  it("returns the base when free and suffixes otherwise", () => {
    expect(uniqueChatName("fix-bug", ["other"])).toBe("fix-bug");
    expect(uniqueChatName("fix-bug", ["fix-bug"])).toBe("fix-bug-2");
    expect(uniqueChatName("fix-bug", ["fix-bug", "fix-bug-2"])).toBe("fix-bug-3");
  });

  it("stays within the length cap when suffixing", () => {
    const base = "a".repeat(MAX_CHAT_NAME_LENGTH);
    const name = uniqueChatName(base, [base]);
    expect(name.length).toBeLessThanOrEqual(MAX_CHAT_NAME_LENGTH);
    expect(name.endsWith("-2")).toBe(true);
  });
});

describe("generateChatName", () => {
  it("asks the model with the naming prompt and the message", async () => {
    const complete = vi.fn(async () => reply("fix-flaky-login-test"));
    const name = await generateChatName("the login test flakes in CI", complete);
    expect(name).toBe("fix-flaky-login-test");
    expect(complete).toHaveBeenCalledWith(
      { systemPrompt: CHAT_NAMING_SYSTEM_PROMPT, message: "the login test flakes in CI" },
      expect.any(AbortSignal),
    );
  });

  it("ignores thinking blocks and makes the name unique", async () => {
    const complete = async (): Promise<NamingReply> => ({
      content: [
        { type: "thinking", text: "hmm, something about logins" },
        { type: "text", text: "fix-login" },
      ],
      stopReason: "stop",
    });
    expect(await generateChatName("x", complete, { existingNames: ["fix-login"] })).toBe(
      "fix-login-2",
    );
  });

  it("truncates very long messages before sending them", async () => {
    let sent = "";
    await generateChatName("x".repeat(MAX_NAMING_INPUT_CHARS * 3), async ({ message }) => {
      sent = message;
      return reply("big-paste");
    });
    expect(sent.length).toBeLessThan(MAX_NAMING_INPUT_CHARS + 50);
  });

  it("falls back when the model throws", async () => {
    const log = vi.fn();
    const name = await generateChatName(
      "Update the README badges",
      async () => {
        throw new Error("401 unauthorized");
      },
      { log },
    );
    expect(name).toBe("update-the-readme-badges");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("401 unauthorized"));
  });

  it("falls back when the reply is an error or has no usable text", async () => {
    expect(
      await generateChatName("add dark mode", async () =>
        reply("", { stopReason: "error", errorMessage: "overloaded" }),
      ),
    ).toBe("add-dark-mode");
    expect(await generateChatName("add dark mode", async () => reply("!!!"))).toBe(
      "add-dark-mode",
    );
  });

  it("falls back (and aborts the request) when the model is too slow", async () => {
    let seen: AbortSignal | undefined;
    const name = await generateChatName(
      "speed up the build",
      (_req, signal) => {
        seen = signal;
        return new Promise<NamingReply>(() => {});
      },
      { timeoutMs: 20 },
    );
    expect(name).toBe("speed-up-the-build");
    expect(seen?.aborted).toBe(true);
  });
});
