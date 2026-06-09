/** `pirouette server` / `pru server` \u2014 start the server in-process.
 *
 *  Thin wrapper over `runServer()`; the server reads pirouette config and
 *  env vars directly, so there's nothing to bridge here.
 *
 *  Also used by the host bootstrap (inside tmux) to serve the web UI +
 *  REST/WebSocket API.
 */

import { runServer } from "../../server/index.js";

export async function server(opts: { port?: string; dataDir?: string }): Promise<void> {
  const port = opts.port ? Number(opts.port) : undefined;
  const { shutdown } = await runServer({ port, dataDir: opts.dataDir });

  const onExit = async (signal: string) => {
    console.log(`\n[pirouette] received ${signal}, shutting down...`);
    await shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => onExit("SIGINT"));
  process.on("SIGTERM", () => onExit("SIGTERM"));
}
