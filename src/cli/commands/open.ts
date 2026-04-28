/** `pru open` — SSH-tunnel the pirouette server port and open the browser.
 *
 *  We spawn `ssh -L localhost:7777:localhost:7777 -N -f pirouette` so the
 *  tunnel backgrounds; the PID is stashed in `~/.pirouette/tunnel.pid` so
 *  subsequent `pru open` calls don't stack up duplicate forwards.
 *
 *  Set PIROUETTE_URL to skip the tunnel (e.g. for local dev against
 *  `npm run dev`).
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { getConfig } from "../../config.js";
import { loadRemoteState } from "../remote/state.js";
import { PIROUETTE_PORT } from "../remote/container.js";
import { getWebUrl } from "../api.js";

const PID_FILE = path.join(homedir(), ".pirouette", "tunnel.pid");

function readTunnelPid(): number | null {
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    // verify it's still alive
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function writeTunnelPid(pid: number): void {
  mkdirSync(path.dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(pid));
}

function clearTunnelPid(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* already gone */
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    execSync(`${cmd} "${url}"`, { stdio: "ignore" });
  } catch {
    console.log(`(could not auto-open; visit ${url} manually)`);
  }
}

export async function open(): Promise<void> {
  const cfg = getConfig();

  // If the user has set PIROUETTE_URL explicitly, trust it (local dev mode).
  if (process.env.PIROUETTE_URL) {
    const url = getWebUrl();
    console.log(`opening ${url}`);
    openBrowser(url);
    return;
  }

  const state = loadRemoteState();
  if (!state.instanceId) {
    // No remote — assume the user is running the server locally on the
    // default port and just open the browser.
    const url = `http://localhost:${cfg.container.pirouette_port}`;
    console.log(`(no remote configured) opening ${url}`);
    openBrowser(url);
    return;
  }

  const existing = readTunnelPid();
  if (existing) {
    console.log(`tunnel already running (pid ${existing})`);
  } else {
    console.log(`opening SSH tunnel ${cfg.container.pirouette_port} -> ${cfg.ssh.host_alias}:${PIROUETTE_PORT}`);
    const child = spawn(
      "ssh",
      [
        "-L",
        `${cfg.container.pirouette_port}:localhost:${PIROUETTE_PORT}`,
        "-N",
        "-f",
        cfg.ssh.host_alias,
      ],
      { stdio: "inherit" },
    );
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ssh -f exited with code ${code}`));
      });
      child.on("error", reject);
    });

    // `ssh -f` backgrounds itself and exits; find the real child PID.
    // pgrep returns the longest-running ssh with our tunnel args.
    try {
      const { execSync } = await import("node:child_process");
      const pid = execSync(
        `pgrep -f "ssh -L ${cfg.container.pirouette_port}:localhost:${PIROUETTE_PORT}" | head -1`,
      )
        .toString()
        .trim();
      if (pid) writeTunnelPid(Number(pid));
    } catch {
      // pgrep not available or nothing matched; tunnel still works, we just
      // can't track it for cleanup.
    }
  }

  const url = `http://localhost:${cfg.container.pirouette_port}`;
  console.log(`opening ${url}`);
  openBrowser(url);
}

export async function close(): Promise<void> {
  const pid = readTunnelPid();
  if (!pid) {
    console.log("no tunnel tracked.");
    return;
  }
  try {
    process.kill(pid);
    console.log(`stopped tunnel (pid ${pid})`);
  } catch {
    console.log(`tunnel (pid ${pid}) already gone`);
  }
  clearTunnelPid();
}
