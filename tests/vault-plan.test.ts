import { strict as assert } from "node:assert"
import { test } from "node:test"

import * as pulumi from "@pulumi/pulumi"
import type { MockResourceArgs } from "@pulumi/pulumi/runtime"
import { Effect } from "effect"

import {
  createVaultFoundationEffect,
  planVaultFoundationEffect,
  type VaultFoundationArgs,
} from "@dsqr/pulumi-vault"

import { vault } from "../infra/vault/config.ts"

const resources: MockResourceArgs[] = []

await pulumi.runtime.setMocks(
  {
    call: (args) => args.inputs,
    newResource: (args) => {
      resources.push(args)
      return { id: `${args.name}-id`, state: args.inputs }
    },
  },
  "vault-homelab",
  "dev",
  true,
)

const foundationArgs = (): VaultFoundationArgs => ({
  connection: {
    address: "https://vault.example.test:8200",
    token: pulumi.secret("mock-token"),
  },
  resourceNames: vault.resourceNames,
  kv: vault.kv,
  secretPaths: vault.secretPaths,
  humanAdminPolicy: vault.policies.humanAdmin,
  externalSecretsPolicies: vault.policies.externalSecrets,
  externalSecretsKubernetesRole: vault.externalSecretsKubernetesRole,
  pkiIssuers: vault.pkiIssuers,
  audit: vault.audit,
})

test("Vault validates the complete foundation before provider registration", () => {
  const count = resources.length
  const error = Effect.runSync(
    Effect.flip(
      createVaultFoundationEffect({
        ...foundationArgs(),
        kv: {
          ...vault.kv,
          path: "../kv",
        },
      }),
    ),
  )

  assert.match(error.message, /normalized mount name/)
  assert.equal(resources.length, count)
})

test("Vault rejects malformed secret paths and duplicate fields", () => {
  const args = foundationArgs()
  const error = Effect.runSync(
    Effect.flip(
      planVaultFoundationEffect({
        ...args,
        secretPaths: {
          ...args.secretPaths,
          unsafe: {
            path: "../root",
            description: "Unsafe",
            fields: ["TOKEN", "TOKEN"],
          },
        },
      }),
    ),
  )

  assert.match(error.message, /relative, normalized/)
})

test("Vault rejects malformed AppRole CIDRs", () => {
  const args = foundationArgs()
  const gateway = args.pkiIssuers.gatewayCaddy!
  const error = Effect.runSync(
    Effect.flip(
      planVaultFoundationEffect({
        ...args,
        pkiIssuers: {
          ...args.pkiIssuers,
          gatewayCaddy: {
            ...gateway,
            appRole: {
              ...gateway.appRole!,
              tokenBoundCidrs: ["10.10.60.999/32"],
            },
          },
        },
      }),
    ),
  )

  assert.match(error.message, /explicit, non-global source CIDRs/)
})

test("Vault rejects duplicate physical policies across foundation categories", () => {
  const args = foundationArgs()
  const [policyKey, policy] = Object.entries(args.externalSecretsPolicies)[0]!
  const count = resources.length
  const error = Effect.runSync(
    Effect.flip(
      createVaultFoundationEffect({
        ...args,
        externalSecretsPolicies: {
          ...args.externalSecretsPolicies,
          [policyKey]: {
            ...policy,
            name: args.humanAdminPolicy.name,
          },
        },
      }),
    ),
  )

  assert.match(error.message, /policy names must be non-empty and unique/)
  assert.equal(resources.length, count)
})

test("Vault rejects duplicate physical Kubernetes auth roles across consumers", () => {
  const args = foundationArgs()
  const [issuerKey, issuer] = Object.entries(args.pkiIssuers).find(
    ([, candidate]) => candidate.kubernetesAuthRole,
  )!
  const count = resources.length
  const error = Effect.runSync(
    Effect.flip(
      createVaultFoundationEffect({
        ...args,
        pkiIssuers: {
          ...args.pkiIssuers,
          [issuerKey]: {
            ...issuer,
            kubernetesAuthRole: {
              ...issuer.kubernetesAuthRole!,
              backend: args.externalSecretsKubernetesRole.backend,
              roleName: args.externalSecretsKubernetesRole.roleName,
            },
          },
        },
      }),
    ),
  )

  assert.match(error.message, /unique backend and role-name identities/)
  assert.equal(resources.length, count)
})
