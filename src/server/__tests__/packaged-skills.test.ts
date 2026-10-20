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

  it("includes the agent-messaging skill", () => {
    const { skills } = loadSkillsFromDir({ dir: packagedSkillsDir(), source: "pirouette" });
    const messaging = skills.find((s) => s.name === "agent-messaging");
    expect(messaging).toBeDefined();
    expect(messaging!.description).toContain("pru send");
    expect(messaging!.disableModelInvocation).toBe(false);
  });

  it("includes the captain and watch skills", () => {
    const { skills } = loadSkillsFromDir({ dir: packagedSkillsDir(), source: "pirouette" });
    const captain = skills.find((s) => s.name === "captain");
    expect(captain).toBeDefined();
    expect(captain!.description).toContain("crew");
    expect(captain!.disableModelInvocation).toBe(false);
    const watch = skills.find((s) => s.name === "watch");
    expect(watch).toBeDefined();
    expect(watch!.description).toContain("instead of sleeping or polling");
  });

  it("includes the compact skill", () => {
    const { skills } = loadSkillsFromDir({ dir: packagedSkillsDir(), source: "pirouette" });
    const compact = skills.find((s) => s.name === "compact");
    expect(compact).toBeDefined();
    expect(compact!.description).toContain("pru compact");
    expect(compact!.disableModelInvocation).toBe(false);
  });
});
