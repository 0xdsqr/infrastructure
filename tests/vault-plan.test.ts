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
  externalSecretsKubernetesAuthBoundaries: vault.externalSecretsKubernetesAuthBoundaries,
  pkiIssuers: vault.pkiIssuers,
  audit: vault.audit,
})

test("Vault accepts an existing audit device with an empty description", () => {
  assert.doesNotThrow(() => Effect.runSync(planVaultFoundationEffect({
    ...foundationArgs(), audit: { ...vault.audit, description: "" },
  })))
})

test("Vault rejects empty audit paths and options before registering resources", () => {
  for (const audit of [
    { ...vault.audit, path: " " },
    { ...vault.audit, options: {} },
    { ...vault.audit, options: { file_path: " " } },
    { ...vault.audit, options: { " ": "/var/log/vault/audit.log" } },
  ]) {
    const count = resources.length
    const error = Effect.runSync(Effect.flip(createVaultFoundationEffect({
      ...foundationArgs(), audit,
    })))
    assert.match(error.message, /audit devices require non-empty path and options/)
    assert.equal(resources.length, count)
  }
})

test("Vault rejects unsafe dedicated CA configuration before registering resources", () => {
  const original = vault.pkiIssuers.indigoHubbleServer
  for (const managedCa of [
    { ...original.managedCa, ttlHours: 720 },
    { ...original.managedCa, ttlHours: 5 * 365 * 24 + 1 },
    { ...original.managedCa, commonName: " " },
  ]) {
    const count = resources.length
    const error = Effect.runSync(Effect.flip(createVaultFoundationEffect({
      ...foundationArgs(), pkiIssuers: { isolated: { ...original, managedCa } },
    })))
    assert.match(error.message, /unique managed CA mount/)
    assert.equal(resources.length, count)
  }
  const collision = Effect.runSync(Effect.flip(planVaultFoundationEffect({
    ...foundationArgs(), pkiIssuers: { isolated: { ...original, backend: vault.kv.path } },
  })))
  assert.match(collision.message, /KV mount path/)
  const duplicate = Effect.runSync(Effect.flip(planVaultFoundationEffect({
    ...foundationArgs(), pkiIssuers: {
      isolated: original,
      duplicate: { ...original, roleName: "other", policyName: "other" },
    },
  })))
  assert.match(duplicate.message, /unique managed CA mount/)
})

test("Vault accepts only explicitly enabled literal leftmost wildcard names", () => {
  const original = vault.pkiIssuers.indigoHubbleServer
  for (const [allowWildcardCertificates, allowedDomains] of [
    [false, ["*.indigo.hubble-grpc.cilium.io"]],
    [true, ["*.*.hubble-grpc.cilium.io"]],
    [true, ["node*.indigo.hubble-grpc.cilium.io"]],
  ] as const) {
    const error = Effect.runSync(Effect.flip(planVaultFoundationEffect({
      ...foundationArgs(), pkiIssuers: { isolated: {
        ...original, allowWildcardCertificates, allowedDomains,
      } },
    })))
    assert.match(error.message, /exact lowercase DNS names/)
  }
  assert.doesNotThrow(() => Effect.runSync(planVaultFoundationEffect(foundationArgs())))
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

test("Vault rejects PKI roles targeting undeclared Kubernetes auth backends", () => {
  const args = foundationArgs()
  const issuer = args.pkiIssuers.indigoGatewayOrigin!
  const count = resources.length
  const error = Effect.runSync(
    Effect.flip(
      createVaultFoundationEffect({
        ...args,
        pkiIssuers: {
          ...args.pkiIssuers,
          indigoGatewayOrigin: {
            ...issuer,
            kubernetesAuthRole: {
              ...issuer.kubernetesAuthRole!,
              backend: "kubernetes-missing",
            },
          },
        },
      }),
    ),
  )

  assert.match(error.message, /must reference a declared external or managed Kubernetes auth backend/)
  assert.equal(resources.length, count)
})

test("Vault rejects Kubernetes auth boundaries without isolated reviewer configuration", () => {
  const args = foundationArgs()
  const indigo = args.externalSecretsKubernetesAuthBoundaries!.indigo!
  const count = resources.length
  const error = Effect.runSync(
    Effect.flip(
      createVaultFoundationEffect({
        ...args,
        externalSecretsKubernetesAuthBoundaries: {
          ...args.externalSecretsKubernetesAuthBoundaries,
          indigo: {
            ...indigo,
            backend: {
              ...indigo.backend,
              disableLocalCaJwt: false,
            },
          },
        },
      }),
    ),
  )

  assert.match(error.message, /disabled local CA\/JWT discovery/)
  assert.equal(resources.length, count)
})
