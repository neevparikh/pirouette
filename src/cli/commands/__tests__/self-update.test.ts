/** Unit tests for the pure helpers behind `pru self-update`. The command's
 *  side-effecting parts (systemd-run launch) aren't exercised here — they
 *  require a real systemd host — but the spec-resolution logic that decides
 *  WHAT gets installed is pure and worth locking down, since getting it
 *  wrong means either a no-op update or installing the wrong package. */
import { describe, expect, it } from "vitest";

import {
  compareVersions,
  isExactVersion,
  judgeVersionChange,
  packageName,
  parseGitSpec,
  resolveInstallPlan,
  resolvePackageSpec,
  specVersion,
} from "../self-update.js";

describe("packageName", () => {
  it("strips a version tag from a scoped package", () => {
    expect(packageName("@neevparikh/pirouette@1.2.3")).toBe("@neevparikh/pirouette");
    expect(packageName("@neevparikh/pirouette@latest")).toBe("@neevparikh/pirouette");
  });

  it("strips a version tag from an unscoped package", () => {
    expect(packageName("pirouette@1.2.3")).toBe("pirouette");
  });

  it("leaves a bare package name untouched", () => {
    expect(packageName("@neevparikh/pirouette")).toBe("@neevparikh/pirouette");
    expect(packageName("pirouette")).toBe("pirouette");
  });
});

describe("resolvePackageSpec", () => {
  const noSentinel = () => undefined;

  it("prefers an explicit --package over everything", () => {
    expect(
      resolvePackageSpec(
        { package: "@acme/fork@2.0.0", target: "latest" },
        { PIROUETTE_PACKAGE: "@neevparikh/pirouette@1.0.0" },
        () => "@sentinel/pkg",
      ),
    ).toBe("@acme/fork@2.0.0");
  });

  it("re-pins the version when --target is given, using the env base name", () => {
    expect(
      resolvePackageSpec(
        { target: "1.5.0" },
        { PIROUETTE_PACKAGE: "@neevparikh/pirouette@1.0.0" },
        noSentinel,
      ),
    ).toBe("@neevparikh/pirouette@1.5.0");
  });

  it("falls back to the sentinel file when env is unset", () => {
    expect(
      resolvePackageSpec({ target: "latest" }, {}, () => "@custom/pirouette@0.9.0"),
    ).toBe("@custom/pirouette@latest");
  });

  it("defaults to the public package pinned at @latest with no hints", () => {
    expect(resolvePackageSpec({}, {}, noSentinel)).toBe(
      "@neevparikh/pirouette@latest",
    );
  });

  it("adds @latest to a bare env package when no --target is given", () => {
    expect(
      resolvePackageSpec({}, { PIROUETTE_PACKAGE: "@neevparikh/pirouette" }, noSentinel),
    ).toBe("@neevparikh/pirouette@latest");
  });

  it("keeps an env package's pinned version when no --target is given", () => {
    expect(
      resolvePackageSpec(
        {},
        { PIROUETTE_PACKAGE: "@neevparikh/pirouette@3.1.4" },
        noSentinel,
      ),
    ).toBe("@neevparikh/pirouette@3.1.4");
  });

  it("ignores blank env / sentinel values", () => {
    expect(
      resolvePackageSpec({}, { PIROUETTE_PACKAGE: "   " }, () => "  "),
    ).toBe("@neevparikh/pirouette@latest");
  });
});

describe("parseGitSpec", () => {
  it("expands github: shorthand to an https clone URL", () => {
    expect(parseGitSpec("github:neevparikh/pirouette")).toEqual({
      url: "https://github.com/neevparikh/pirouette.git",
      ref: undefined,
    });
  });

  it("captures a #ref fragment", () => {
    expect(parseGitSpec("github:neevparikh/pirouette#feat/x")).toEqual({
      url: "https://github.com/neevparikh/pirouette.git",
      ref: "feat/x",
    });
  });

  it("strips the git+ transport prefix", () => {
    expect(parseGitSpec("git+https://example.com/x.git#v1")).toEqual({
      url: "https://example.com/x.git",
      ref: "v1",
    });
  });

  it("accepts an ssh git URL", () => {
    expect(parseGitSpec("git@github.com:owner/repo.git")).toEqual({
      url: "git@github.com:owner/repo.git",
      ref: undefined,
    });
  });

  it("accepts a bare https github URL", () => {
    expect(parseGitSpec("https://github.com/owner/repo")).toEqual({
      url: "https://github.com/owner/repo",
      ref: undefined,
    });
  });

  it("returns null for plain npm specs", () => {
    expect(parseGitSpec("@neevparikh/pirouette@1.2.3")).toBeNull();
    expect(parseGitSpec("pirouette")).toBeNull();
    expect(parseGitSpec("")).toBeNull();
  });
});

describe("resolveInstallPlan", () => {
  const noSentinel = () => undefined;
  const gitUrl = () => "https://github.com/neevparikh/pirouette.git";

  it("defaults to npm mode with the resolved spec", () => {
    expect(resolveInstallPlan({}, {}, noSentinel, gitUrl)).toEqual({
      mode: "npm",
      spec: "@neevparikh/pirouette@latest",
    });
  });

  it("--from-git (bare) builds the default repo's default branch", () => {
    expect(resolveInstallPlan({ fromGit: true }, {}, noSentinel, gitUrl)).toEqual({
      mode: "git",
      url: "https://github.com/neevparikh/pirouette.git",
      ref: undefined,
    });
  });

  it("--from-git <ref> builds that ref", () => {
    expect(
      resolveInstallPlan({ fromGit: "main" }, {}, noSentinel, gitUrl),
    ).toEqual({ mode: "git", url: gitUrl(), ref: "main" });
  });

  it("--ref overrides the --from-git value", () => {
    expect(
      resolveInstallPlan({ fromGit: "main", ref: "abc123" }, {}, noSentinel, gitUrl),
    ).toEqual({ mode: "git", url: gitUrl(), ref: "abc123" });
  });

  it("a git-ish --package auto-selects git mode", () => {
    expect(
      resolveInstallPlan(
        { package: "github:neevparikh/pirouette#dev" },
        {},
        noSentinel,
        gitUrl,
      ),
    ).toEqual({
      mode: "git",
      url: "https://github.com/neevparikh/pirouette.git",
      ref: "dev",
    });
  });

  it("--ref overrides a #ref embedded in --package", () => {
    expect(
      resolveInstallPlan(
        { package: "github:neevparikh/pirouette#dev", ref: "v2" },
        {},
        noSentinel,
        gitUrl,
      ),
    ).toEqual({
      mode: "git",
      url: "https://github.com/neevparikh/pirouette.git",
      ref: "v2",
    });
  });

  it("a non-git --package stays npm mode", () => {
    expect(
      resolveInstallPlan({ package: "@acme/fork@2.0.0" }, {}, noSentinel, gitUrl),
    ).toEqual({ mode: "npm", spec: "@acme/fork@2.0.0" });
  });
});

describe("specVersion / isExactVersion", () => {
  it("pulls the version or dist-tag out of a spec", () => {
    expect(specVersion("@scope/pkg@1.2.3")).toBe("1.2.3");
    expect(specVersion("pkg@latest")).toBe("latest");
    expect(specVersion("@scope/pkg")).toBeUndefined();
    expect(specVersion("pkg")).toBeUndefined();
  });

  it("tells a pinned version apart from a dist-tag", () => {
    expect(isExactVersion("1.2.3")).toBe(true);
    expect(isExactVersion("1.2.3-rc.1")).toBe(true);
    expect(isExactVersion("latest")).toBe(false);
    expect(isExactVersion("next")).toBe(false);
    expect(isExactVersion(undefined)).toBe(false);
  });
});

describe("compareVersions", () => {
  it("orders released versions numerically, not lexically", () => {
    expect(compareVersions("0.16.1", "0.14.2")).toBe(1);
    expect(compareVersions("0.14.2", "0.16.1")).toBe(-1);
    expect(compareVersions("0.16.1", "0.16.1")).toBe(0);
    // The lexical trap: "0.9.0" > "0.10.0" as strings.
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  });

  it("sorts a prerelease below its release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    // Numeric identifiers sort below alphanumeric ones (semver rule 11).
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });

  it("tolerates v-prefixes, build metadata and short versions", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3+build9", "1.2.3+build1")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("2", "1.9.9")).toBe(1);
  });
});

describe("judgeVersionChange", () => {
  const base = { pinned: false, force: false, spec: "@neevparikh/pirouette@latest" };

  it("proceeds when the target is newer", () => {
    expect(
      judgeVersionChange({ ...base, installed: "0.16.1", target: "0.17.0" }).action,
    ).toBe("proceed");
  });

  it("refuses the real-world downgrade that motivated this", () => {
    // npm `latest` was 0.14.2 while the host ran 0.16.1 (installed from
    // git). A bare `pru self-update` would have rolled the fleet back.
    const verdict = judgeVersionChange({ ...base, installed: "0.16.1", target: "0.14.2" });
    expect(verdict.action).toBe("refuse");
    if (verdict.action !== "refuse") throw new Error("unreachable");
    expect(verdict.message).toContain("0.14.2");
    expect(verdict.message).toContain("0.16.1");
    // The message has to point at the way forward, not just say no.
    expect(verdict.message).toContain("--from-git");
    expect(verdict.message).toContain("--force");
  });

  it("does nothing (and does NOT restart) when already on the target", () => {
    const verdict = judgeVersionChange({ ...base, installed: "0.16.1", target: "0.16.1" });
    expect(verdict.action).toBe("up-to-date");
    if (verdict.action !== "up-to-date") throw new Error("unreachable");
    expect(verdict.message).toContain("no restart");
  });

  it("refuses a PINNED downgrade too — this is the exact command that caused the outage", () => {
    // `pirouette self-update --package @neevparikh/pirouette@0.14.2` against
    // a host running 0.16.1. An earlier draft classified a pinned exact
    // version as "explicit intent" and waved it through; it rolled the fleet
    // back across a state-schema boundary and destroyed 64 archived flags.
    // Naming a version is not consent to move a live fleet backwards.
    const verdict = judgeVersionChange({
      ...base,
      installed: "0.16.1",
      target: "0.14.2",
      pinned: true,
      spec: "@neevparikh/pirouette@0.14.2",
    });
    expect(verdict.action).toBe("refuse");
    if (verdict.action !== "refuse") throw new Error("unreachable");
    // --force is the only escape hatch on offer; the message must not
    // advertise "just pin the old version" as a supported route, since that
    // is the shape of the command that did the damage.
    expect(verdict.message).toContain("--force");
    expect(verdict.message).not.toMatch(/--target <?older/);
  });

  it("allows a pinned reinstall of the SAME version (repair)", () => {
    expect(
      judgeVersionChange({
        ...base,
        installed: "0.16.1",
        target: "0.16.1",
        pinned: true,
        spec: "@neevparikh/pirouette@0.16.1",
      }).action,
    ).toBe("proceed");
  });

  it("still allows a pinned UPGRADE", () => {
    expect(
      judgeVersionChange({
        ...base,
        installed: "0.16.1",
        target: "0.17.0",
        pinned: true,
        spec: "@neevparikh/pirouette@0.17.0",
      }).action,
    ).toBe("proceed");
  });

  it("--force overrides everything", () => {
    expect(
      judgeVersionChange({ ...base, installed: "0.16.1", target: "0.14.2", force: true }).action,
    ).toBe("proceed");
    expect(
      judgeVersionChange({ ...base, installed: "0.16.1", target: "0.16.1", force: true }).action,
    ).toBe("proceed");
  });

  it("stands down when it can't tell (registry lookup failed, unknown install)", () => {
    // A flaky `npm view` must never be able to block an update.
    expect(judgeVersionChange({ ...base, installed: "0.16.1" }).action).toBe("proceed");
    expect(judgeVersionChange({ ...base, target: "0.17.0" }).action).toBe("proceed");
    expect(judgeVersionChange({ ...base }).action).toBe("proceed");
  });
});
