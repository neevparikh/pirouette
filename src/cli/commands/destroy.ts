/** `pru destroy` — destroy the host.
 *
 *  Provider-aware: on the EC2 path this terminates the instance, optionally
 *  also deletes the EBS data volume (with `--delete-volume`). Phase 2 will
 *  extend this for byo-host (no-op on compute; `--delete-volume` deletes
 *  the persistent dirs after confirmation).
 *
 *  After destroy you can `pru setup` again; unless you also deleted the
 *  persistent volume, your agent state survives.
 */

import { getProvider } from "../remote/provider.js";

export async function destroy(opts: { deleteVolume?: boolean; yes?: boolean }): Promise<void> {
  await getProvider().destroy({
    deletePersistent: opts.deleteVolume === true,
    yes: opts.yes,
  });
}
