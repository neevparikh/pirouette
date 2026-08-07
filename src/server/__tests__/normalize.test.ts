import { describe, it, expect } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { normalizeEvent } from "../normalize.js";

/** Build a message_start / message_end event without dragging in pi's full
 *  AgentMessage type (the normalizer only reads `role` and `content`). */
function messageEvent(
  type: "message_start" | "message_end",
  role: string,
  content: unknown,
): AgentSessionEvent {
  return { type, message: { role, content } } as unknown as AgentSessionEvent;
}

describe("normalizeEvent", () => {
  it("passes through a plain-string user message", () => {
    expect(normalizeEvent(messageEvent("message_end", "user", "hello"))).toEqual({
      type: "message_end",
      role: "user",
      text: "hello",
    });
  });

  it("joins the text blocks of a structured user message", () => {
    const event = messageEvent("message_end", "user", [
      { type: "text", text: "look at " },
      { type: "text", text: "this" },
    ]);
    expect(normalizeEvent(event)).toEqual({
      type: "message_end",
      role: "user",
      text: "look at this",
    });
  });

  it("splits user image attachments out of the text as data URLs", () => {
    const event = messageEvent("message_end", "user", [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "what is this?" },
    ]);
    expect(normalizeEvent(event)).toEqual({
      type: "message_end",
      role: "user",
      text: "what is this?",
      images: [{ dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" }],
    });
  });

  it("omits images from message_start so the blob is only sent once", () => {
    const event = messageEvent("message_start", "user", [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "hi" },
    ]);
    expect(normalizeEvent(event)).toEqual({
      type: "message_start",
      role: "user",
      text: "hi",
    });
  });

  it("still summarizes assistant tool calls as [toolCall:name]", () => {
    const event = messageEvent("message_end", "assistant", [
      { type: "text", text: "running " },
      { type: "toolCall", name: "bash" },
    ]);
    expect(normalizeEvent(event)).toEqual({
      type: "message_end",
      role: "assistant",
      text: "running [toolCall:bash]",
    });
  });
});
