/** `pru destroy` — clear pirouette's local state for the host, and optionally
 *  nuke the host's persistent dirs (`--delete-data`).
 *
 *  Pirouette doesn't own the host itself, so this never touches the host's
 *  lifecycle — only the pirouette state on it. Without `--delete-data`, your
 *  agent state survives and `pru setup` brings it back.
 */

import { getHost } from "../remote/host.js";

export async function destroy(opts: { deleteData?: boolean; yes?: boolean }): Promise<void> {
  await getHost().destroy({
    deletePersistent: opts.deleteData === true,
    yes: opts.yes,
  });
}
