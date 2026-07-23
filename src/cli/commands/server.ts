/** `pirouette server` / `pru server` \u2014 start the server in-process.
 *
 *  Thin wrapper over `runServer()`; the server reads pirouette config and
 *  env vars directly, so there's nothing to bridge here.
 *
 *  Also used by the host bootstrap (as the systemd service's ExecStart) to
 *  serve the web UI + REST/WebSocket API.
 */

import { runServer } from "../../server/index.js";

export async function server(opts: { port?: string; dataDir?: string }): Promise<void> {
  const port = opts.port ? Number(opts.port) : undefined;
  const { shutdown } = await runServer({ port, dataDir: opts.dataDir });

  // Graceful shutdown, made robust for the systemd `restart` path (which
  // agents trigger via `pru self-update`):
  //   - `shuttingDown` guard: a second SIGTERM/SIGINT during teardown is
  //     ignored rather than starting a second (racing) shutdown.
  //   - hard-deadline timer: if shutdown() ever wedges, we still exit
  //     before systemd's TimeoutStopSec elapses and it SIGKILLs us (which
  //     would skip the final state flush). 25s < the unit's 30s.
  let shuttingDown = false;
  const onExit = async (signal: string) => {
    if (shuttingDown) {
      console.log(`[pirouette] already shutting down; ignoring ${signal}`);
      return;
    }
    shuttingDown = true;
    console.log(`\n[pirouette] received ${signal}, shutting down...`);
    const forceExit = setTimeout(() => {
      console.error("[pirouette] shutdown timed out; forcing exit");
      process.exit(0);
    }, 25_000);
    if (typeof forceExit.unref === "function") forceExit.unref();
    try {
      await shutdown();
    } catch (err) {
      console.error("[pirouette] error during shutdown:", err);
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };
  process.on("SIGINT", () => onExit("SIGINT"));
  process.on("SIGTERM", () => onExit("SIGTERM"));
}
