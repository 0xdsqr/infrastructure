import * as pulumi from "@pulumi/pulumi"
import { Config, Effect, Redacted } from "effect"

import type { VaultConnectionEnvironment } from "@dsqr/pulumi-vault"

import { optionalBoolean, optionalRedacted, optionalString } from "../environment.ts"

const environment = Config.all({
  address: optionalString("VAULT_ADDR"),
  legacyAddress: optionalString("VAULT_ADDRESS"),
  token: optionalRedacted("VAULT_TOKEN"),
  caCertFile: optionalString("VAULT_CACERT"),
  skipTlsVerify: optionalBoolean("VAULT_SKIP_VERIFY"),
  allowInsecureLocalDev: optionalBoolean("VAULT_ALLOW_INSECURE_LOCAL_DEV"),
})

export const loadVaultEnvironment = Effect.fn("VaultEnvironment.load")(function* () {
  const values = yield* environment

  return {
    address: values.address ?? values.legacyAddress,
    token: values.token ? pulumi.secret(Redacted.value(values.token)) : undefined,
    caCertFile: values.caCertFile,
    skipTlsVerify: values.skipTlsVerify,
    allowInsecureLocalDev: values.allowInsecureLocalDev,
  } satisfies VaultConnectionEnvironment
})
