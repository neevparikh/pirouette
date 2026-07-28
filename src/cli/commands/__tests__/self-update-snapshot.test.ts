/**
 * Tests for the rollback snapshot in `scripts/pirouette-self-update.sh`.
 *
 * The snapshot is the safety net that lets a failed update put the old
 * build back. It is also, structurally, the easiest part of this feature
 * to break without noticing: it runs inside a detached systemd unit, it
 * fails soft (one WARN line, update proceeds), and the only run where its
 * absence matters is a run that was already going wrong. On this host it
 * was silently dead -- `npm pack --ignore-scripts` still executes a
 * directory's `prepare` script as of npm 10.9, and pirouette's `prepare`
 * is `npm run build`, which needs devDependencies a global install does
 * not have. Every self-update logged "rollback disabled" and nobody read
 * it.
 *
 * So these tests drive the real shell function against a fake install
 * that reproduces that trap: a package whose `prepare` exits non-zero.
 * A snapshot must still come out, and it must be a tarball npm would
 * accept back.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "pirouette-self-update.sh",
);

/** A stand-in for the global install: prebuilt `dist/`, no devDependencies,
 *  and a `prepare` script that fails exactly like the real one does when
 *  the build tooling is missing. */
function fakeInstall(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pirouette-fake-install-"));
  mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(root, "dist", "cli", "index.js"), "// prebuilt\n");
  mkdirSync(path.join(root, "node_modules", "junk"), { recursive: true });
  writeFileSync(
    path.join(root, "node_modules", "junk", "package.json"),
    '{"name":"junk","version":"1.0.0"}\n',
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "@neevparikh/pirouette",
        version: "9.9.9",
        bin: { pru: "dist/cli/index.js" },
        files: ["dist", "scripts"],
        scripts: { prepare: "exit 1", build: "exit 1" },
      },
      null,
      2,
    ) + "\n",
  );
  return root;
}

/** Run snapshot_current_install() from the real script against `dir`, and
 *  report the tarball path it chose (empty string = rollback disabled). */
function runSnapshot(dir: string): { tarball: string; output: string } {
  const harness = `
    set -uo pipefail
    BACKUP_TARBALL=""
    log(){ printf '%s\\n' "[log] $*" >&2; }
    installed_package_dir(){ printf '%s\\n' ${JSON.stringify(dir)}; }
    eval "$(sed -n '/^snapshot_current_install()/,/^}/p' ${JSON.stringify(SCRIPT)})"
    snapshot_current_install
    printf 'TARBALL=%s\\n' "$BACKUP_TARBALL"
  `;
  const out = execFileSync("bash", ["-c", harness], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const m = /TARBALL=(.*)/.exec(out);
  return { tarball: (m?.[1] ?? "").trim(), output: out };
}

describe("self-update rollback snapshot", () => {
  it("packs an install whose prepare script fails (the npm --ignore-scripts trap)", () => {
    const { tarball } = runSnapshot(fakeInstall());

    expect(tarball, "no snapshot => the update would run with rollback disabled").not.toBe("");
    expect(existsSync(tarball)).toBe(true);
  }, 120_000);

  it("produces a tarball that carries the prebuilt dist and no node_modules", () => {
    const { tarball } = runSnapshot(fakeInstall());
    const listing = execFileSync("tar", ["tzf", tarball], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);

    expect(listing).toContain("package/package.json");
    expect(listing).toContain("package/dist/cli/index.js");
    // `files` excludes it, and it is ~170MB in the real install.
    expect(listing.filter((f) => f.includes("node_modules"))).toEqual([]);
  }, 120_000);

  it("keeps the snapshot's identity but drops the build hooks that broke packing", () => {
    const { tarball } = runSnapshot(fakeInstall());
    const pkg = JSON.parse(
      execFileSync("tar", ["xzf", tarball, "-O", "package/package.json"], {
        encoding: "utf8",
      }),
    ) as { version?: string; name?: string; scripts?: Record<string, string> };

    // Same build, byte-for-byte, as far as npm is concerned...
    expect(pkg.name).toBe("@neevparikh/pirouette");
    expect(pkg.version).toBe("9.9.9");
    // ...minus the lifecycle hooks, which only ever run when installing
    // from a directory or git ref -- never for the tarball reinstall the
    // rollback path performs.
    expect(pkg.scripts?.prepare).toBeUndefined();
    expect(pkg.scripts?.prepack).toBeUndefined();
  }, 120_000);

  it("reports rollback disabled rather than a bogus path when there is no install", () => {
    const missing = path.join(tmpdir(), "pirouette-does-not-exist-12345");
    const { tarball, output } = runSnapshot(missing);

    expect(tarball).toBe("");
    expect(output + "").not.toContain("rollback snapshot:");
  }, 120_000);
});
