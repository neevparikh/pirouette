/** Unit tests for the pure helpers behind `pru self-update`. The command's
 *  side-effecting parts (systemd-run launch) aren't exercised here — they
 *  require a real systemd host — but the spec-resolution logic that decides
 *  WHAT gets installed is pure and worth locking down, since getting it
 *  wrong means either a no-op update or installing the wrong package. */
import { describe, expect, it } from "vitest";

import {
  packageName,
  parseGitSpec,
  resolveInstallPlan,
  resolvePackageSpec,
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
