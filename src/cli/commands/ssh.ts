/** `pru ssh` — shell into the pirouette host (with agent forwarding).
 *
 *  Provider-aware:
 *    - EC2: default is `ssh pirouette-container` (jumps through host into
 *      container sshd on port 2222). `--host` lands on the EC2 host instead.
 *    - byo-host: lands directly on the user's SSH alias. `--host` is a no-op
 *      (there's no host/container split).
 */

import { execSync } from "node:child_process";

import { getConfig } from "../../config.js";
import { getProvider } from "../remote/provider.js";

export async function ssh(opts: { host?: boolean }): Promise<void> {
  const cfg = getConfig();
  const provider = getProvider();

  // EC2 supports a "host shell" mode (skip the ProxyJump). On byo-host
  // host/shell are the same alias so --host is a harmless override.
  const target =
    opts.host && provider.kind === "ec2"
      ? cfg.ssh.host_alias
      : provider.shellAlias();

  console.log(`ssh ${target}`);
  try {
    execSync(`ssh ${target}`, { stdio: "inherit" });
  } catch {
    // ssh exits non-zero on disconnect; that's fine.
  }
}
