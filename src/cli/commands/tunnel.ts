/** `pru tunnel` — forward a TCP port from laptop to container.
 *
 *  Primary use case: OAuth loopback flows in CLI tools running inside the
 *  container that bind a local HTTP listener. Most modern CLIs support
 *  device flow and don't need this (`aws sso login`, `gh auth login --web`,
 *  `gcloud auth login --no-launch-browser`, ...). The exception is older
 *  tools like `gws` that only do "loopback IP" OAuth.
 *
 *  Behaviour:
 *  - Default: `pru tunnel 42103` adds a forward via the existing SSH master
 *    connection (instant, no new TCP) and stays in foreground until ctrl-c.
 *    On ctrl-c, the forward is cancelled and we exit.
 *  - `--background`: add the forward, print a hint, return immediately. Run
 *    `pru tunnel --close 42103` to remove later.
 *  - `--close`: remove a previously-added forward.
 *  - If no master exists, fall back to spawning a fresh `ssh -L … -N`
 *    process (slower, but works without setup).
 *
 *  Port spec is either `PORT` (laptop and container same port) or
 *  `LOCAL:REMOTE` for asymmetric mappings.
 */

import { spawn } from "node:child_process";
import net from "node:net";

import { getProvider } from "../remote/provider.js";
import { loadRemoteState } from "../remote/state.js";
import { sshControl } from "../remote/ssh.js";

interface PortSpec {
  local: number;
  remote: number;
}

function parsePortSpec(spec: string): PortSpec {
  const m = spec.match(/^(\d+)(?::(\d+))?$/);
  if (!m) {
    throw new Error(`bad port spec ${JSON.stringify(spec)} (expected "PORT" or "LOCAL:REMOTE")`);
  }
  const local = Number(m[1]);
  const remote = Number(m[2] ?? m[1]);
  for (const [name, p] of [["local", local], ["remote", remote]] as const) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`${name} port must be an integer in 1..65535 (got ${p})`);
    }
  }
  return { local, remote };
}

/** Probe whether `localhost:port` is already bound on the laptop. We try to
 *  bind a server briefly; if it succeeds the port is free. */
async function isLocalPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/** Resolve the SSH alias to forward through. Provider-aware:
 *  EC2 returns `<host_alias>-container` (ProxyJump'd to the container's
 *  sshd); byo-host returns the user's single alias. Throws if no
 *  state — forwarding requires a provisioned host. */
function ensureRemote(): string {
  const state = loadRemoteState();
  // Both providers stamp at least one identifier on first provision; if
  // neither is set we haven't run `pru setup` yet.
  if (!state.instanceId && !state.sshAlias) {
    throw new Error("no remote host configured. Run `pru setup` first.");
  }
  return getProvider().shellAlias();
}

function forwardSpec(p: PortSpec): string {
  return `${p.local}:localhost:${p.remote}`;
}

export interface TunnelOptions {
  background?: boolean;
  close?: boolean;
}

export async function tunnel(spec: string, opts: TunnelOptions = {}): Promise<void> {
  let port: PortSpec;
  try {
    port = parsePortSpec(spec);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
  const containerAlias = ensureRemote();

  if (opts.close) {
    await closeTunnel(port, containerAlias);
    return;
  }

  // Refuse if the laptop port is already bound — likely we'd silently fail
  // or shadow another service.
  const free = await isLocalPortFree(port.local);
  if (!free) {
    console.error(`error: laptop port ${port.local} is already in use.`);
    console.error(`       (try a different LOCAL port: \`pru tunnel ${port.local + 1}:${port.remote}\`)`);
    process.exit(1);
  }

  // Try the master first. ssh -O check returns 0 if a master is alive.
  const master = await sshControl(containerAlias, "check");

  if (master.ok) {
    // Master exists — add the forward via -O forward (instant, no new TCP).
    const result = await sshControl(containerAlias, "forward", ["-L", forwardSpec(port)]);
    if (!result.ok) {
      console.error(`failed to add forward via control master:\n${result.stderr}`);
      process.exit(1);
    }
    console.log(`tunnel: localhost:${port.local} -> ${containerAlias}:${port.remote} (via master)`);

    if (opts.background) {
      console.log(`(backgrounded; close with \`pru tunnel --close ${spec}\`)`);
      return;
    }

    // Foreground: hold here until ctrl-c, then cancel the forward.
    console.log("press ctrl-c to close.");
    await new Promise<void>((resolve) => {
      const onSig = async () => {
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
        await closeTunnel(port, containerAlias).catch(() => {});
        resolve();
      };
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);
    });
    return;
  }

  // No master — fall back to a fresh ssh -L … -N. This will itself become
  // the master (ControlMaster auto in our SSH config block), so subsequent
  // `pru tunnel` calls in the next 10m piggyback on it.
  console.log(`tunnel: localhost:${port.local} -> ${containerAlias}:${port.remote} (new connection)`);
  if (opts.background) {
    // -f backgrounds after auth completes.
    const child = spawn("ssh", ["-L", forwardSpec(port), "-N", "-f", containerAlias], {
      stdio: "inherit",
    });
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ssh -f exited ${code}`))));
      child.on("error", reject);
    });
    console.log(`(backgrounded; close with \`pru tunnel --close ${spec}\`)`);
    return;
  }

  // Foreground: child holds the connection; ctrl-c kills it.
  console.log("press ctrl-c to close.");
  const child = spawn("ssh", ["-L", forwardSpec(port), "-N", containerAlias], { stdio: "inherit" });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

async function closeTunnel(port: PortSpec, containerAlias: string): Promise<void> {
  // First try the master.
  const result = await sshControl(containerAlias, "cancel", ["-L", forwardSpec(port)]);
  if (result.ok) {
    console.log(`closed: localhost:${port.local} -> ${containerAlias}:${port.remote}`);
    return;
  }

  // No master, or the master doesn't have that forward. Fall back to pgrep
  // for a backgrounded ssh -L … process matching this spec.
  try {
    const { execSync } = await import("node:child_process");
    const pids = execSync(
      `pgrep -f "ssh -L ${forwardSpec(port)}" || true`,
    )
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (pids.length === 0) {
      console.log(`no tunnel found for ${port.local}:${port.remote}`);
      return;
    }
    for (const pid of pids) {
      try {
        process.kill(Number(pid));
      } catch {
        /* race: already gone */
      }
    }
    console.log(`closed: localhost:${port.local} -> ${containerAlias}:${port.remote} (killed pid ${pids.join(", ")})`);
  } catch (err) {
    console.error(`failed to close tunnel: ${(err as Error).message}`);
  }
}
