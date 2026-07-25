import { Effect } from "effect"

import { requiredRedacted } from "../environment.ts"

const environment = requiredRedacted("HCLOUD_TOKEN")

/**
 * Validate the standard credential consumed by the hcloud provider before any
 * invokes or resources are registered. Keeping authentication ambient avoids
 * introducing an explicit provider and changing existing provider identity.
 */
export const loadHetznerEnvironment = Effect.fn("HetznerEnvironment.load")(() => environment)
