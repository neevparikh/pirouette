import { describe, expect, it } from "vitest";

import { buildSendBody } from "../send.js";

const INSIDE = { PI_SESSION_FILE: "/d/sessions/parent-a1b2c3d4/s.jsonl" } as NodeJS.ProcessEnv;

describe("buildSendBody", () => {
  it("sends as the calling agent from inside one", () => {
    expect(buildSendBody("hi", {}, INSIDE)).toEqual({ message: "hi", from: "a1b2c3d4" });
  });

  it("sends as the user from a human shell", () => {
    expect(buildSendBody("hi", {}, {} as NodeJS.ProcessEnv)).toEqual({ message: "hi" });
  });

  it("--as-user overrides the detected sender", () => {
    expect(buildSendBody("hi", { asUser: true }, INSIDE)).toEqual({ message: "hi" });
  });

  it("--follow-up sets the mode", () => {
    expect(buildSendBody("hi", { followUp: true }, INSIDE)).toEqual({
      message: "hi",
      from: "a1b2c3d4",
      mode: "followUp",
    });
  });
});
