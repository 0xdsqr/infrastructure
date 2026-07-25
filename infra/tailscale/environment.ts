import { Config, Effect } from "effect"

import { optionalString, requiredRedacted } from "../environment.ts"

const environment = Config.all({
  oauthClientId: requiredRedacted("TAILSCALE_OAUTH_CLIENT_ID"),
  oauthClientSecret: requiredRedacted("TAILSCALE_OAUTH_CLIENT_SECRET"),
  tailnet: optionalString("TAILSCALE_TAILNET"),
})

/**
 * Fail before Pulumi resource registration when the ambient credentials the
 * Tailscale provider consumes are unavailable. The provider continues to read
 * its standard environment variables, so no explicit provider (and therefore
 * no provider identity change) is introduced.
 */
export const loadTailscaleEnvironment = Effect.fn("TailscaleEnvironment.load")(() => environment)
