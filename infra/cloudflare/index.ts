import * as pulumi from "@pulumi/pulumi"
import { Effect, Redacted } from "effect"

import { createCloudflareEdgeEffect, planCloudflareEdgeEffect } from "@dsqr/pulumi-cloudflare"
import { registerPulumiResource, runPulumiProgram } from "@dsqr/pulumi-shared"

import { infrastructure } from "../../infra.config.ts"
import { loadCloudflareConfig } from "./config.ts"

export const cloudflareEdge = runPulumiProgram(
  Effect.gen(function* () {
    const cloudflareConfig = yield* loadCloudflareConfig()
    const zoneIds = {
      dsqrDev: cloudflareConfig.dsqrDevZoneId,
      fidaraIo: cloudflareConfig.fidaraZoneId,
      tastingswithtayCom: cloudflareConfig.tastingswithtayZoneId,
    } as const satisfies Record<keyof typeof infrastructure.cloudflare.zones, string>
    const staticEdge = {
      accountId: cloudflareConfig.accountId,
      zoneIds,
      zones: infrastructure.cloudflare.zones,
      zoneSecurity: infrastructure.cloudflare.zoneSecurity,
      tunnel: infrastructure.cloudflare.tunnel,
      r2Buckets: infrastructure.cloudflare.r2Buckets,
      ingressRules: infrastructure.cloudflare.ingressRules,
    } as const

    // Loading apiToken above is the typed presence check for the default
    // Cloudflare provider. Do not construct an explicit provider here: doing
    // so would change every existing resource's provider identity.
    yield* planCloudflareEdgeEffect({
      ...staticEdge,
      dnsRecords: [
        {
          zone: "dsqrDev",
          name: infrastructure.cloudflare.mailHostname,
          type: "A",
          proxied: false,
          ttl: 1,
        },
        ...infrastructure.cloudflare.dnsRecords,
      ],
    })

    const hetznerMail = yield* registerPulumiResource(
      cloudflareConfig.hetznerMailStack,
      () => new pulumi.StackReference(cloudflareConfig.hetznerMailStack),
    )
    const mailIpv4 = hetznerMail.getOutput("ipv4Address")

    return yield* createCloudflareEdgeEffect({
      ...staticEdge,
      tunnelSecret: pulumi.secret(Redacted.value(cloudflareConfig.tunnelSecret)),
      dnsRecords: [
        {
          zone: "dsqrDev",
          name: infrastructure.cloudflare.mailHostname,
          type: "A",
          content: mailIpv4,
          proxied: false,
          ttl: 1,
        },
        ...infrastructure.cloudflare.dnsRecords,
      ],
    })
  }),
)
