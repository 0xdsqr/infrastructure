import * as pulumi from "@pulumi/pulumi"

import { createHetznerMailServerEffect } from "@dsqr/pulumi-hetzner"
import { runPulumiProgram } from "@dsqr/pulumi-shared"
import { Effect } from "effect"

import { hetznerMail } from "./config.ts"
import { loadHetznerEnvironment } from "./environment.ts"

const mail = runPulumiProgram(
  Effect.gen(function* () {
    yield* loadHetznerEnvironment()
    return yield* createHetznerMailServerEffect(hetznerMail)
  }),
)

export const serverName = mail.server.name
export const serverId = mail.server.id
export const selectedServerType = pulumi.output(mail.serverType)
export const selectedLocation = pulumi.output(mail.location)
export const selectedImage = pulumi.output(mail.image)
export const sshKeyBound = mail.sshKeyName
export const ipv4Address = mail.server.ipv4Address
export const ipv6Address = mail.server.ipv6Address
export const firewallId = mail.firewall?.id
export const ipv4Rdns = mail.ipv4RdnsRecord.dnsPtr
