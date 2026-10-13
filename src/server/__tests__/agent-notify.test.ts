/** POST /api/agents/:id/notify validation. The endpoint only checks the
 *  body and broadcasts it, so the rules worth pinning down are here: what
 *  a notification may say, and which URLs it may open on click. */
import { describe, expect, it } from "vitest";

import { NOTIFY_BODY_MAX, NOTIFY_TITLE_MAX, parseNotifyRequest } from "../agent-notify.js";

describe("parseNotifyRequest", () => {
  it("accepts a body and titles it with the agent's name by default", () => {
    expect(parseNotifyRequest({ body: "approve the login" }, "backfill")).toEqual({
      ok: true,
      notification: { title: "backfill", body: "approve the login" },
    });
  });

  it("keeps an explicit title and an https url", () => {
    const r = parseNotifyRequest(
      { title: "AWS login needed", body: "code ABCD-EFGH", url: "https://example.com/device?user_code=ABCD-EFGH" },
      "backfill",
    );
    expect(r).toEqual({
      ok: true,
      notification: {
        title: "AWS login needed",
        body: "code ABCD-EFGH",
        url: "https://example.com/device?user_code=ABCD-EFGH",
      },
    });
  });

  it("falls back to the agent name for a blank title and ignores an empty url", () => {
    expect(parseNotifyRequest({ title: "  ", body: "x", url: "" }, "agent-a")).toEqual({
      ok: true,
      notification: { title: "agent-a", body: "x" },
    });
  });

  it.each([
    ["missing body", {}],
    ["blank body", { body: "   " }],
    ["non-string body", { body: 42 }],
    ["non-string title", { body: "x", title: 1 }],
    ["overlong body", { body: "x".repeat(NOTIFY_BODY_MAX + 1) }],
    ["overlong title", { body: "x", title: "t".repeat(NOTIFY_TITLE_MAX + 1) }],
    ["relative url", { body: "x", url: "/login" }],
    ["javascript url", { body: "x", url: "javascript:alert(1)" }],
    ["data url", { body: "x", url: "data:text/html,hi" }],
  ])("rejects %s", (_label, body) => {
    expect(parseNotifyRequest(body, "agent-a").ok).toBe(false);
  });

  it.each([null, "text", ["body"]])("rejects a non-object body (%j)", (body) => {
    expect(parseNotifyRequest(body, "agent-a").ok).toBe(false);
  });
});
