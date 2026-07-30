/**
 * `pru handoff` with no agent argument means "hand off whoever is running
 * this command". That only works if we can recover the agent id from the
 * environment pi hands to its bash tool — there is no PIROUETTE_AGENT_ID.
 */
import { describe, expect, it } from "vitest";

import { selfAgentRef } from "../handoff.js";

describe("selfAgentRef", () => {
  it("reads the agent id off the session directory", () => {
    expect(
      selfAgentRef({
        PI_SESSION_FILE:
          "/data/pirouette/data/sessions/fix-login-a1b2c3d4/2026-01-01T00-00-00-000Z_uuid.jsonl",
      } as NodeJS.ProcessEnv),
    ).toBe("a1b2c3d4");
  });

  it("copes with a slug that itself contains digits and dashes", () => {
    expect(
      selfAgentRef({
        PI_SESSION_FILE: "/d/sessions/fix-777-take-2-deadbeef/s.jsonl",
      } as NodeJS.ProcessEnv),
    ).toBe("deadbeef");
  });

  it("returns null outside an agent, or when the layout doesn't match", () => {
    expect(selfAgentRef({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      selfAgentRef({ PI_SESSION_FILE: "/tmp/scratch/session.jsonl" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
