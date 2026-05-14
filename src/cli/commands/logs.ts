/** `pru logs` — tail pirouette server logs from the remote host.
 *
 *  Several sources available:
 *    --server   (default)  tail $PIROUETTE_DATA_DIR/logs/pirouette.log
 *    --tmux                capture the live tmux pane (latest state, no history)
 *    --entrypoint          entrypoint startup log (yadm, npm install, sshd launch)
 *    --boot                EC2 cloud-init output (user-data bootstrap)
 *
 *  Use `-f` / `--follow` to stream. Implemented by tailing over SSH; the
 *  provider builds the remote command (EC2 wraps in `docker exec pirouette`;
 *  future byo-host runs directly).
 */

import { spawn } from "node:child_process";

import { getProvider, type LogsOptions } from "../remote/provider.js";

export type { LogsOptions };

export async function logs(opts: LogsOptions): Promise<void> {
  const { command, sshAlias } = getProvider().buildLogsCommand(opts);

  const child = spawn("ssh", ["-t", sshAlias, command], { stdio: "inherit" });
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
}
