/** `pru open` \u2014 open the dashboard in your browser.
 *
 *  Resolves the URL from the same precedence chain the CLI uses:
 *    1. `PIROUETTE_URL` env var
 *    2. `server.public_url` from config
 *    3. Refuse with a useful message
 *
 *  No SSH tunnel here \u2014 the canonical access path is whatever
 *  `public_url` points at (typically `https://<host>.<tailnet>.ts.net/`
 *  served by `tailscale serve`). If the tailnet is down and you need
 *  to escape-hatch via SSH, see the README troubleshooting section
 *  for the manual `ssh -L 7777:localhost:7777 ...` recipe.
 */

import { execSync } from "node:child_process";

import { getConfig } from "../../config.js";

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
  const fromEnv = process.env.PIROUETTE_URL;
  const cfg = getConfig();
  const fromConfig = cfg.server?.public_url ?? "";

  const url = (fromEnv ?? fromConfig).replace(/\/+$/, "");
  if (!url) {
    console.error(
      "error: no dashboard URL configured.\n" +
        "       Set `server.public_url` in ~/.pirouette/config.toml, e.g.:\n" +
        '         [server]\n' +
        '         public_url = "https://pirouette-<you>.<tailnet>.ts.net"\n' +
        "       or export PIROUETTE_URL for this shell.",
    );
    process.exit(1);
  }

  console.log(`opening ${url}`);
  openBrowser(url);
}
