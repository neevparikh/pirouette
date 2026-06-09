/** `pru logs` — tail pirouette logs from the host over SSH.
 *
 *  Sources:
 *    --server   (default)  tail $PIROUETTE_DATA_DIR/logs/pirouette.log
 *    --tmux                capture the live tmux pane (latest state, no history)
 *    --entrypoint          the bootstrap log (yadm, npm install, server start)
 *
 *  Use `-f` / `--follow` to stream.
 */

import { spawn } from "node:child_process";

import { getHost, type LogsOptions } from "../remote/host.js";

export type { LogsOptions };

export async function logs(opts: LogsOptions): Promise<void> {
  const { command, sshAlias } = getHost().buildLogsCommand(opts);

  const child = spawn("ssh", ["-t", sshAlias, command], { stdio: "inherit" });
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
}
