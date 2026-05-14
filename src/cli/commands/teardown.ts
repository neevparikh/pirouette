/** `pru teardown` — stop the host without destroying persistent state.
 *
 *  Provider-aware: on the EC2 path this stops the instance (preserving the
 *  EBS data volume + the instance itself). Phase 2 will add a byo-host
 *  provider where this is a no-op (pirouette doesn't own the host).
 *
 *  You still pay for the stopped instance's root EBS volume (~$10/mo for
 *  the default gp3 root) and for the `pirouette-data` volume on the EC2
 *  path. Compute is what dominates, and that stops.
 */

import { getProvider } from "../remote/provider.js";

export async function teardown(): Promise<void> {
  await getProvider().stop();
}
