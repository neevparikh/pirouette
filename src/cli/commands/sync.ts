/** `pru sync` — ship local changes to the remote container without publishing.
 *
 *  Workflow:
 *    1. `npm pack` the local package -> tarball on disk
 *    2. scp it to the host's tarballs directory
 *    3. docker exec `npm install -g /data/tarballs/<tarball>` inside the container
 *    4. kill + restart the pirouette tmux session so the new binary runs
 *
 *  Use when you want to test a local change without going through
 *  `npm version && npm publish`. For production updates, publish normally
 *  and the container's next restart picks it up (or run `pru sync --npm`
 *  to force an in-place upgrade from the registry).
 */

import { execFileSync } from "node:child_process";
import { readdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConfig } from "../../config.js";
import { scp, ssh } from "../remote/ssh.js";
import { CONTAINER_NAME } from "../remote/container.js";
import { pushSecrets } from "../remote/secrets.js";

const REMOTE_TARBALLS_DIR = "/var/lib/pirouette/tarballs";

function findPackageRoot(): string {
  // src/cli/commands/sync.ts   -> repo root (../../..)
  // dist/cli/commands/sync.js  -> repo root (../../..)
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..", "..");
}

async function restartServerInContainer(): Promise<void> {
  await ssh(
    `docker exec ${CONTAINER_NAME} tmux kill-session -t pirouette 2>/dev/null || true`,
  );
  // Keep tmux start line in sync with the entrypoint script.
  await ssh(
    `docker exec ${CONTAINER_NAME} tmux new-session -d -s pirouette ` +
      `'pirouette server 2>&1 | tee -a /data/logs/pirouette.log'`,
  );
}

export async function sync(opts: { npm?: boolean; secrets?: boolean }): Promise<void> {
  // `--secrets` re-pushes the laptop-local auth state into the container
  // without going through a full redeploy. Use after `/login`'ing a new
  // provider locally, or after rotating creds on the laptop.
  if (opts.secrets) {
    console.log("pushing local auth secrets to container...");
    const cfg = getConfig();
    const result = await pushSecrets(cfg);
    console.log(
      `  done. pushed=${result.pushed}, skipped=${result.skipped}` +
        (result.missing.length > 0 ? `, missing=${result.missing.join(", ")}` : ""),
    );
    return;
  }

  if (opts.npm) {
    console.log(`upgrading to latest published @neevparikh/pirouette in container...`);
    // `npm install -g` writes to /usr/lib/node_modules which requires root.
    // The container's user has passwordless sudo (matches the entrypoint).
    // We pipe through `tee /tmp/pir-install.log` so the *real* install exit
    // code propagates (a `| tail -3` masks failures with exit 0).
    await ssh(
      `docker exec ${CONTAINER_NAME} bash -c 'set -o pipefail; sudo npm install -g @neevparikh/pirouette@latest 2>&1 | tail -3'`,
    );
    await restartServerInContainer();
    console.log("  done. pirouette server restarted.");
    return;
  }

  const repoRoot = findPackageRoot();
  console.log("building package...");
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });

  console.log("npm pack...");
  // npm pack writes the tarball to cwd; capture its name via --json.
  const packOut = execFileSync("npm", ["pack", "--json"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
  const parsed = JSON.parse(packOut) as Array<{ filename: string }>;
  const tarballName = parsed[0]?.filename;
  if (!tarballName) throw new Error("npm pack did not report a filename");
  // npm >=10 writes to cwd; for scoped packages the filename includes a
  // slash (@scope/name-version.tgz). Find the actual on-disk path.
  const onDisk = findTarball(repoRoot, tarballName);

  console.log(`scp ${path.basename(onDisk)} \u2192 ${REMOTE_TARBALLS_DIR}/`);
  await ssh(`mkdir -p ${REMOTE_TARBALLS_DIR}`);
  const remoteName = path.basename(onDisk);
  await scp(onDisk, `${REMOTE_TARBALLS_DIR}/${remoteName}`);

  console.log("installing inside container...");
  // sudo + pipefail so an install failure isn't silently swallowed by
  // `| tail` (npm's error mode-of-failure is permission-denied here).
  await ssh(
    `docker exec ${CONTAINER_NAME} bash -c 'set -o pipefail; sudo npm install -g /data/tarballs/${remoteName} 2>&1 | tail -3'`,
  );

  console.log("restarting server...");
  await restartServerInContainer();

  // Clean up local tarball
  try {
    unlinkSync(onDisk);
  } catch {
    /* best effort */
  }

  console.log("  sync complete.");
  console.log("  pru logs     # verify it came back up");
}

/** npm pack for scoped packages writes to cwd with the flattened filename
 *  `neevparikh-pirouette-0.1.0.tgz`, but reports the scoped form in --json.
 *  Look for both. */
function findTarball(dir: string, reported: string): string {
  const reportedPath = path.join(dir, reported);
  try {
    readdirSync(dir);
  } catch {
    throw new Error(`cannot read package directory: ${dir}`);
  }
  const flat = reported.replace(/^@/, "").replace("/", "-");
  const flatPath = path.join(dir, flat);
  try {
    readdirSync(dir).includes(flat);
  } catch {
    /* ignore */
  }
  // If reportedPath exists, use it; else try the flat form.
  for (const p of [reportedPath, flatPath]) {
    try {
      readdirSync(path.dirname(p));
      // simplest check: attempt to stat by renaming to itself
      renameSync(p, p);
      return p;
    } catch {
      /* keep looking */
    }
  }
  throw new Error(`could not locate npm pack output (tried ${reportedPath}, ${flatPath})`);
}
