import * as pulumi from "@pulumi/pulumi"
import { Config, Effect, Redacted } from "effect"

import type { ProxmoxConnectionEnvironment } from "@dsqr/pulumi-proxmox"

import { optionalBoolean, optionalRedacted, optionalString } from "../environment.ts"

const environment = Config.all({
  endpoint: optionalString("PROXMOX_BASE_URL"),
  legacyEndpoint: optionalString("PROXMOX_VE_ENDPOINT"),
  apiToken: optionalRedacted("PROXMOX_API_TOKEN"),
  legacyApiToken: optionalRedacted("PROXMOX_VE_API_TOKEN"),
  username: optionalString("PROXMOX_USER"),
  legacyUsername: optionalString("PROXMOX_VE_USERNAME"),
  tokenId: optionalString("PROXMOX_TOKEN_ID"),
  tokenSecret: optionalRedacted("PROXMOX_TOKEN_SECRET"),
  insecure: optionalBoolean("PROXMOX_INSECURE_SKIP_VERIFY"),
  legacyInsecure: optionalBoolean("PROXMOX_VE_INSECURE"),
  allowInsecureLocalDev: optionalBoolean("PROXMOX_ALLOW_INSECURE_LOCAL_DEV"),
})

export const loadProxmoxEnvironment = Effect.fn("ProxmoxEnvironment.load")(function* () {
  const values = yield* environment

  return {
    endpoint: values.endpoint ?? values.legacyEndpoint,
    apiToken: values.apiToken
      ? pulumi.secret(Redacted.value(values.apiToken))
      : values.legacyApiToken
        ? pulumi.secret(Redacted.value(values.legacyApiToken))
        : undefined,
    username: values.username ?? values.legacyUsername,
    tokenId: values.tokenId,
    tokenSecret: values.tokenSecret,
    insecure: values.insecure ?? values.legacyInsecure,
    allowInsecureLocalDev: values.allowInsecureLocalDev,
  } satisfies ProxmoxConnectionEnvironment
})
