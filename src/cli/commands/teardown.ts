/** `pru teardown` — stop the pirouette server on the host without destroying
 *  persistent state.
 *
 *  Pirouette doesn't own the host's lifecycle, so this just stops the
 *  pirouette systemd service. The host stays up and all persistent state
 *  survives; `pru setup` resumes.
 */

import { getHost } from "../remote/host.js";

export async function teardown(): Promise<void> {
  await getHost().stop();
}
