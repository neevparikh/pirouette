/** Container orchestration helpers — runs `docker` commands on the EC2 host
 *  over SSH. Keeps all the `docker run` / `docker exec` plumbing out of the
 *  setup command so each step is independently testable.
 */

import { containerHome, getConfig } from "../../config.js";
import { scp, ssh } from "./ssh.js";

/** Where the pirouette-managed bits live on the EC2 host. */
export const DATA_MOUNT = "/var/lib/pirouette";
export const AGENT_SOCK_MOUNT = `${DATA_MOUNT}/agent-sock`;
export const SCRIPTS_DIR = `${DATA_MOUNT}/scripts`;
/** Path to the entrypoint script on the EC2 HOST's filesystem (where we
 *  scp it). */
export const ENTRYPOINT_HOST_PATH = `${SCRIPTS_DIR}/pirouette-entrypoint.sh`;
/** Path to the same file as seen from INSIDE the container. The DATA_MOUNT
 *  dir is bind-mounted at `/data` in the container, so this is what we pass
 *  to `docker run --entrypoint`. */
export const ENTRYPOINT_CONTAINER_PATH = `/data/scripts/pirouette-entrypoint.sh`;

/** Host-side bind-mount path for the container's home directory. Derived
 *  from container_user so users with a non-default image (and a different
 *  user) get their own directory. */
export function containerHomeMount(cfg = getConfig()): string {
  return `${DATA_MOUNT}/home-${cfg.container.container_user}`;
}

/** Docker port mappings:
 *  - 7777 → pirouette server (HTTP + WebSocket)
 *  - 2222 → container sshd (so ssh -A can reach into the container)
 *
 *  We don't use --network=host because the container's sshd would collide
 *  with the EC2 host's sshd on port 22.
 */
export const PIROUETTE_PORT = 7777;
export const CONTAINER_SSH_PORT = 2222;

/** Name of the docker container we manage. */
export const CONTAINER_NAME = "pirouette";

/** Status of the pirouette container on the remote host. */
export interface ContainerStatus {
  exists: boolean;
  running: boolean;
  image?: string;
  id?: string;
}

export async function getContainerStatus(): Promise<ContainerStatus> {
  // Use `docker ps -a` + format so we get one line per matching container.
  const { stdout } = await ssh(
    `docker ps -a --filter name=^${CONTAINER_NAME}$ --format '{{.ID}}\\t{{.Image}}\\t{{.State}}'`,
  ).catch(() => ({ stdout: "", stderr: "" }));
  const line = stdout.trim().split("\n").find((l) => l.trim());
  if (!line) return { exists: false, running: false };
  const [id, image, state] = line.split("\t");
  return { exists: true, running: state === "running", id, image };
}

export async function uploadEntrypointScript(localPath: string): Promise<void> {
  // Host side we chown to uid 1000 so the container's non-root user can
  // read it. Most images use uid 1000 for their dev user; if yours doesn't,
  // adjust in `pirouette-entrypoint.sh` or build a derived image.
  await scp(localPath, ENTRYPOINT_HOST_PATH);
  await ssh(`chmod +x ${ENTRYPOINT_HOST_PATH} && sudo chown 1000:1000 ${ENTRYPOINT_HOST_PATH}`);
}

/** Start (or restart) the pirouette container with our entrypoint, bind mounts,
 *  and port forwards. If a container of the same name already exists, remove
 *  it first — we always want the latest bind-mount configuration. */
export async function startContainer(opts: {
  /** Image tag to run. */
  image: string;
  /** Env vars the entrypoint reads. Keys/values are passed through shell-safely. */
  env?: Record<string, string>;
}): Promise<void> {
  const cfg = getConfig();
  const image = opts.image ?? cfg.container.image;

  // Always replace any stale container so we pick up bind-mount / env changes.
  // This also cleans up `Created`-state containers from a previously failed
  // docker run (docker will leave those around on OCI errors).
  await ssh(`docker rm -f ${CONTAINER_NAME} 2>/dev/null || true`);

  const envArgs = Object.entries(opts.env ?? {})
    .map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`)
    .join(" ");

  const homeMount = containerHomeMount(cfg);
  const dockerRun = [
    "docker run -d",
    `--name ${CONTAINER_NAME}`,
    `--restart=unless-stopped`,
    // Port mappings
    `-p ${PIROUETTE_PORT}:${PIROUETTE_PORT}`,
    `-p ${CONTAINER_SSH_PORT}:22`,
    // Bind mounts
    `-v ${DATA_MOUNT}:/data`,
    `-v ${homeMount}:${containerHome(cfg)}`,
    `-v ${AGENT_SOCK_MOUNT}:/agent-sock`,
    // Env
    envArgs,
    // Override the upstream entrypoint — ours starts sshd + pirouette server.
    // This path is resolved INSIDE the container; our scp'd script is visible
    // there via the /data bind mount.
    `--entrypoint ${ENTRYPOINT_CONTAINER_PATH}`,
    // sudo inside the container needs a tty-friendly setup; sudoers is
    // expected to be configured in the image with NOPASSWD.
    shellQuote(image),
  ].join(" ");

  await ssh(dockerRun);
}

export async function dockerLogs(lines = 200): Promise<string> {
  const { stdout } = await ssh(
    `docker logs --tail ${lines} ${CONTAINER_NAME} 2>&1 || true`,
  );
  return stdout;
}

export async function tmuxCapture(sessionName = "pirouette"): Promise<string> {
  const { stdout } = await ssh(
    `docker exec ${CONTAINER_NAME} tmux capture-pane -p -t ${sessionName} 2>&1 || true`,
  );
  return stdout;
}

/** Wait for the pirouette server inside the container to respond to /api/health.
 *  We check via docker exec so we don't depend on the port-forward being up yet. */
export async function waitForServerReady(opts: {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onAttempt?: (i: number) => void;
} = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 3 * 60 * 1000);
  const interval = opts.pollIntervalMs ?? 3000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    opts.onAttempt?.(attempt);
    try {
      const { stdout } = await ssh(
        `docker exec ${CONTAINER_NAME} curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${PIROUETTE_PORT}/api/health 2>&1 || true`,
      );
      if (stdout.trim() === "200") return;
    } catch {
      // container may not be fully up yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`pirouette server inside container did not become healthy in ${opts.timeoutMs ?? 180_000}ms`);
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}
