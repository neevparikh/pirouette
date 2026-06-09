/** `pru setup` — set up (or refresh) the host pirouette runs on.
 *
 *  Uploads the bootstrap script over SSH and runs it: install pirouette,
 *  start the server in tmux, optionally migrate `$HOME` onto the persistent
 *  volume (skipped when the host's `adopt` flag is set) and bring up
 *  tailscale. Idempotent — safe to re-run.
 *
 *  Targets the host selected by `--host` (or `default_host`).
 */

import { getHost } from "../remote/host.js";

export async function setup(): Promise<void> {
  const host = getHost();
  await host.preflight();
  await host.provision();
}
