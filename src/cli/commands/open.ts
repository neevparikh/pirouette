/** `pru open` — open the dashboard in your browser.
 *
 *  Resolves the URL the same way the CLI's API client does (PIROUETTE_URL,
 *  else the selected host's `public_url`). If neither is set, prints a useful
 *  message. There's no SSH tunnel here — the canonical access path is whatever
 *  `public_url` points at (typically a `tailscale serve` HTTPS URL). To
 *  escape-hatch via SSH, see the `pru setup` output for the `ssh -L` recipe.
 */

import { execSync } from "node:child_process";

import { getWebUrl } from "../api.js";

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
  let url: string;
  try {
    url = getWebUrl();
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  console.log(`opening ${url}`);
  openBrowser(url);
}
