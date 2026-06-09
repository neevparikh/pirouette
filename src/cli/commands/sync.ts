/** `pru sync` — ship local changes (or a fresh npm install) to the host.
 *
 *    - `--secrets`: re-push laptop auth state (auth.json, AWS caches, ...).
 *    - `--npm`:     `npm install -g <pkg>` on the host + restart the server.
 *    - (default):   npm pack locally, upload, install from tarball, restart.
 */

import { getHost } from "../remote/host.js";

export async function sync(opts: { npm?: boolean; secrets?: boolean }): Promise<void> {
  const host = getHost();

  if (opts.secrets) {
    console.log("pushing local auth secrets to remote...");
    const result = await host.pushSecrets();
    console.log(
      `  done. pushed=${result.pushed}, skipped=${result.skipped}` +
        (result.missing.length > 0 ? `, missing=${result.missing.join(", ")}` : ""),
    );
    return;
  }

  if (opts.npm) {
    await host.syncFromNpm();
    return;
  }

  await host.syncFromLocalBuild();
}
