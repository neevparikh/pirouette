/** `pru sync` — ship local changes (or a fresh npm install) to the remote.
 *
 *  Provider-aware: the provider implements the actual sync mechanics.
 *    - `--secrets`: re-push laptop auth state.
 *    - `--npm`:     `npm install -g <pkg>` on remote + restart server.
 *    - (default):   npm pack locally, upload, install from tarball, restart.
 *
 *  EC2 wraps everything in `docker exec`; byo-host runs directly via SSH.
 */

import { getProvider } from "../remote/provider.js";

export async function sync(opts: { npm?: boolean; secrets?: boolean }): Promise<void> {
  const provider = getProvider();

  if (opts.secrets) {
    console.log("pushing local auth secrets to remote...");
    const result = await provider.pushSecrets();
    console.log(
      `  done. pushed=${result.pushed}, skipped=${result.skipped}` +
        (result.missing.length > 0 ? `, missing=${result.missing.join(", ")}` : ""),
    );
    return;
  }

  if (opts.npm) {
    await provider.syncFromNpm();
    return;
  }

  await provider.syncFromLocalBuild();
}
