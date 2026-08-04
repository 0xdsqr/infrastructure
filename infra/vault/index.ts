import { Effect } from "effect"

import { createVaultFoundationEffect, loadVaultConnectionConfigEffect } from "@dsqr/pulumi-vault"
import { runPulumiProgram } from "@dsqr/pulumi-shared"

import { infrastructure } from "../../infra.config.ts"
import { loadVaultEnvironment } from "./environment.ts"

export const foundation = runPulumiProgram(
  Effect.gen(function* () {
    const environment = yield* loadVaultEnvironment()
    const connection = yield* loadVaultConnectionConfigEffect({ environment })
    return yield* createVaultFoundationEffect({
      connection,
      resourceNames: infrastructure.vault.resourceNames,
      kv: infrastructure.vault.kv,
      secretPaths: infrastructure.vault.secretPaths,
      humanAdminPolicy: infrastructure.vault.policies.humanAdmin,
      externalSecretsPolicies: infrastructure.vault.policies.externalSecrets,
      externalSecretsKubernetesRole: infrastructure.vault.externalSecretsKubernetesRole,
      raftSnapshotAppRole: infrastructure.vault.raftSnapshotAppRole,
      pkiIssuers: infrastructure.vault.pkiIssuers,
      audit: infrastructure.vault.audit,
    })
  }),
)

export const kvMount = foundation.mounts.kv
export const policies = foundation.policies
export const externalSecretsKubernetesRole = foundation.externalSecretsKubernetesRole
export const raftSnapshotAppRole = foundation.raftSnapshotAppRole
export const pkiIssuers = foundation.pkiIssuers
export const audit = foundation.audit
export const secretPaths = foundation.secretPaths
