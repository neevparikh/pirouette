/** `pru ssh` — shell into the pirouette container (with agent forwarding).
 *
 *  Default: `ssh pirouette-container` (jumps through the EC2 host into the
 *  container's sshd on port 2222). You land as the configured
 *  `container.container_user` with your forwarded agent.
 *
 *  Use `pru ssh --host` to skip the jump and get a shell on the EC2 host
 *  (useful for ops, docker debugging, etc.).
 */

import { execSync } from "node:child_process";

import { getConfig } from "../../config.js";

export async function ssh(opts: { host?: boolean }): Promise<void> {
  const cfg = getConfig();
  const target = opts.host
    ? cfg.ssh.host_alias
    : process.env.PIROUETTE_SSH_HOST ?? `${cfg.ssh.host_alias}-container`;

  console.log(`ssh ${target}`);
  try {
    execSync(`ssh ${target}`, { stdio: "inherit" });
  } catch {
    // ssh exits non-zero on disconnect; that's fine.
  }
}
