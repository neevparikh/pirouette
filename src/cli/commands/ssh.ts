/** `pru ssh` — shell into the selected host (the SSH alias from config).
 *
 *  Agent forwarding etc. are governed by the user's `~/.ssh/config` entry for
 *  the alias; we just run `ssh <alias>`.
 */

import { spawnSync } from "node:child_process";

import { getHost } from "../remote/host.js";

export async function ssh(): Promise<void> {
  const target = getHost().shellAlias();
  console.log(`ssh ${target}`);
  // Arg array (no shell) so an unusual alias can't be misparsed. ssh exits
  // non-zero on disconnect; that's fine, we ignore the status.
  spawnSync("ssh", [target], { stdio: "inherit" });
}
