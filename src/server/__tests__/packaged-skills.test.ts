/**
 * The skills pirouette ships with itself must actually load.
 *
 * They are handed to pi's ResourceLoader as an extra skill path, and pi is
 * lenient: a skill with a broken name or a missing description is dropped or
 * downgraded with a diagnostic nobody reads, and the agent silently never
 * learns the workflow. Cheap to assert here instead.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { packagedSkillsDir } from "../agent-manager.js";

describe("packaged skills", () => {
  it("resolves to a directory inside the package", () => {
    const dir = packagedSkillsDir();
    expect(path.basename(dir)).toBe("skills");
    expect(existsSync(dir)).toBe(true);
  });

  it("loads cleanly, and includes the handoff skill", () => {
    const { skills, diagnostics } = loadSkillsFromDir({
      dir: packagedSkillsDir(),
      source: "pirouette",
    });
    expect(diagnostics).toEqual([]);
    const handoff = skills.find((s) => s.name === "handoff");
    expect(handoff).toBeDefined();
    // The description is the only part that is always in the agent's
    // context, so it has to carry the "when would I use this" signal.
    expect(handoff!.description.length).toBeGreaterThan(40);
    expect(handoff!.disableModelInvocation).toBe(false);
  });
});
