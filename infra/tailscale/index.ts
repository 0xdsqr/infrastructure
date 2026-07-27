import { runPulumiProgram } from "@dsqr/pulumi-shared"
import { createTailscalePlatformEffect } from "@dsqr/pulumi-tailscale"
import { Effect } from "effect"

import { infrastructure } from "../../infra.config.ts"
import { tailscaleAdminUser } from "./config.ts"
import { loadTailscaleEnvironment } from "./environment.ts"

const tailscale = runPulumiProgram(
  Effect.gen(function* () {
    yield* loadTailscaleEnvironment()

    return yield* createTailscalePlatformEffect({
      policyResourceName: infrastructure.tailscale.policyResourceName,
      policyDocument: infrastructure.tailscale.createPolicy({
        adminUser: tailscaleAdminUser,
      }),
      keySpecs: infrastructure.tailscale.keySpecs,
    })
  }),
)

export const tailscalePolicy = tailscale.policy
