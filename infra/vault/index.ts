import { Effect } from "effect"
import * as pulumi from "@pulumi/pulumi"

import { createVaultFoundationEffect, loadVaultConnectionConfigEffect } from "@dsqr/pulumi-vault"
import { registerPulumiResource, runPulumiProgram } from "@dsqr/pulumi-shared"

import { infrastructure } from "../../infra.config.ts"
import { loadVaultEnvironment } from "./environment.ts"

export const foundation = runPulumiProgram(
  Effect.gen(function* () {
    const environment = yield* loadVaultEnvironment()
    const connection = yield* loadVaultConnectionConfigEffect({ environment })
    const edge = yield* registerPulumiResource(
      "indigo-cloudflare-edge",
      () =>
        new pulumi.StackReference("indigo-cloudflare-edge", { name: "0xdsqr/cloudflare-edge/dev" }),
    )
    const tunnelToken = pulumi.secret(
      edge.requireOutput("indigoEdge").apply((value) => {
        const token = (value as { tunnelToken?: unknown }).tunnelToken
        if (typeof token !== "string" || token.length === 0)
          throw new Error("Indigo tunnel token is missing; deploy the Cloudflare stack first.")
        return JSON.stringify({ token })
      }),
    )
    return yield* createVaultFoundationEffect({
      connection,
      resourceNames: infrastructure.vault.resourceNames,
      kv: infrastructure.vault.kv,
      secretPaths: infrastructure.vault.secretPaths,
      managedKvSecrets: {
        "indigo-cloudflare-tunnel-token": {
          path: infrastructure.vault.secretPaths.indigoCloudflareTunnel.path,
          dataJson: tunnelToken,
        },
      },
      humanAdminPolicy: infrastructure.vault.policies.humanAdmin,
      externalSecretsPolicies: infrastructure.vault.policies.externalSecrets,
      externalSecretsKubernetesRole: infrastructure.vault.externalSecretsKubernetesRole,
      externalSecretsKubernetesAuthBoundaries:
        infrastructure.vault.externalSecretsKubernetesAuthBoundaries,
      raftSnapshotAppRole: infrastructure.vault.raftSnapshotAppRole,
      pkiIssuers: infrastructure.vault.pkiIssuers,
      audit: infrastructure.vault.audit,
    })
  }),
)

export const kvMount = foundation.mounts.kv
export const policies = foundation.policies
export const externalSecretsKubernetesRole = foundation.externalSecretsKubernetesRole
export const externalSecretsKubernetesAuthBoundaries =
  foundation.externalSecretsKubernetesAuthBoundaries
export const raftSnapshotAppRole = foundation.raftSnapshotAppRole
export const pkiIssuers = foundation.pkiIssuers
export const audit = foundation.audit
export const secretPaths = foundation.secretPaths
