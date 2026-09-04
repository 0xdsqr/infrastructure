import { strict as assert } from "node:assert"
import { test } from "node:test"

import * as pulumi from "@pulumi/pulumi"

import { createVaultFoundationEffect } from "@dsqr/pulumi-vault"
import { runPulumiProgram } from "@dsqr/pulumi-shared"

import { vault } from "../infra/vault/config.ts"
import { byName, runPulumiMockProgram } from "./pulumi-state-helpers.ts"

const providerToken = "pulumi:providers:vault"
const mountToken = "vault:index/mount:Mount"
const kvConfigToken = "vault:kv/secretBackendV2:SecretBackendV2"
const authBackendToken = "vault:index/authBackend:AuthBackend"
const kubernetesAuthBackendConfigToken = "vault:kubernetes/authBackendConfig:AuthBackendConfig"
const policyToken = "vault:index/policy:Policy"
const kubernetesRoleToken = "vault:kubernetes/authBackendRole:AuthBackendRole"
const pkiRoleToken = "vault:pkiSecret/secretBackendRole:SecretBackendRole"
const appRoleToken = "vault:appRole/authBackendRole:AuthBackendRole"
const auditToken = "vault:index/audit:Audit"

const externalPolicyNames = {
  argocdFidaraRepo: "hub-a-external-secrets-argocd-fidara-repo",
  argocdGithubWebhook: "hub-a-external-secrets-argocd-github-webhook",
  dotdevStudio: "hub-a-external-secrets-dotdev-studio",
  dotdevWeb: "hub-a-external-secrets-dotdev-web",
  fidaraApi: "hub-a-external-secrets-fidara-api",
  fidaraWeb: "hub-a-external-secrets-fidara-web",
  githubArgoRepoRead: "hub-a-external-secrets-github-argocd-repo-read",
  githubGhcrPull: "hub-a-external-secrets-github-ghcr-pull",
  tastingsWithTayAdmin: "hub-a-external-secrets-tastingswithtay-admin",
  tastingsWithTayShared: "hub-a-external-secrets-tastingswithtay-shared",
  tastingsWithTayWeb: "hub-a-external-secrets-tastingswithtay-web",
} as const

const issuerKeys = [
  "gatewayCaddy",
  "hubATraefikOrigin",
  "indigoGatewayOrigin",
  "postgresKnoxListener",
  "proxmoxListener",
  "rustfsKhaosListener",
  "vaultListener",
] as const

test("Vault preserves provider, policy, auth-role, PKI, and lifecycle state contracts", async () => {
  const deployment = await runPulumiMockProgram({
    program: () =>
      runPulumiProgram(
        createVaultFoundationEffect({
          connection: {
            address: "https://vault.example.test:8200",
            token: "mock-root-token",
            caCertFile: "/etc/ssl/certs/mock-root.pem",
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
        }),
      ),
    outputs: (result) => ({
      kv: result.mounts.kv,
      policies: result.policies,
      externalSecretsKubernetesRole: result.externalSecretsKubernetesRole,
      externalSecretsKubernetesAuthBoundaries: result.externalSecretsKubernetesAuthBoundaries,
      pkiIssuers: result.pkiIssuers,
      audit: result.audit,
    }),
    project: "vault-homelab",
  })

  const resources = deployment.resources.filter(
    (resource) => resource.type === providerToken || resource.type.startsWith("vault:"),
  )
  const expectedResources = [
    [auditToken, "audit"],
    [kubernetesRoleToken, "external-secrets-kubernetes-role-hub-a"],
    [kubernetesRoleToken, "external-secrets-kubernetes-role-indigo"],
    [authBackendToken, "kubernetes-auth-backend-indigo"],
    [kubernetesAuthBackendConfigToken, "kubernetes-auth-backend-config-indigo"],
    [policyToken, "external-secrets-token-self-policy"],
    [policyToken, "external-secrets-token-self-policy-indigo"],
    [policyToken, "external-secrets-policy-indigo-bootstrap-smoke-test"],
    ...Object.keys(externalPolicyNames).map(
      (key) => [policyToken, `external-secrets-policy-${key}`] as const,
    ),
    [policyToken, "human-admin-policy"],
    [mountToken, "kv"],
    [kvConfigToken, "kv-config"],
    ...issuerKeys.flatMap((key) => [
      [pkiRoleToken, `pki-issuer-role-${key}`] as const,
      [policyToken, `pki-issuer-policy-${key}`] as const,
    ]),
    ...(
      [
        "gatewayCaddy",
        "postgresKnoxListener",
        "proxmoxListener",
        "rustfsKhaosListener",
        "vaultListener",
      ] as const
    ).map((key) => [appRoleToken, `pki-issuer-approle-${key}`] as const),
    [kubernetesRoleToken, "pki-issuer-kubernetes-role-hubATraefikOrigin"],
    [kubernetesRoleToken, "pki-issuer-kubernetes-role-indigoGatewayOrigin"],
    [providerToken, "vault"],
  ].sort((left, right) => left[1].localeCompare(right[1]))

  assert.equal(resources.length, expectedResources.length)
  assert.deepEqual(
    resources
      .map((resource) => [resource.type, resource.name] as const)
      .sort((left, right) => left[1].localeCompare(right[1])),
    expectedResources,
  )
  assert.deepEqual(deployment.calls, [])

  const provider = byName(deployment.captured, "vault")
  const providerState = byName(resources, "vault")
  assert.equal(provider.opts.parent, undefined)
  assert.equal(provider.opts.provider, undefined)
  assert.equal(provider.opts.protect, undefined)
  assert.equal(providerState.inputs.address, "https://vault.example.test:8200")
  assert.equal(providerState.inputs.caCertFile, "/etc/ssl/certs/mock-root.pem")
  assert.equal(await pulumi.isSecret(pulumi.output(provider.props.token)), true)

  const lifecycle = (
    name: string,
    {
      protect,
      dependsOn = [],
    }: {
      readonly protect?: boolean
      readonly dependsOn?: ReadonlyArray<string>
    } = {},
  ) => {
    const resource = byName(deployment.captured, name)
    const state = byName(resources, name)
    assert.equal(resource.opts.parent, undefined, `${name}: parent`)
    assert.equal(resource.opts.provider, provider.resource, `${name}: provider`)
    assert.equal(resource.opts.protect, protect, `${name}: protect`)
    assert.equal(resource.opts.retainOnDelete, undefined, `${name}: retainOnDelete`)
    assert.equal(resource.opts.ignoreChanges, undefined, `${name}: ignoreChanges`)
    assert.deepEqual(
      resource.opts.dependsOn,
      dependsOn.length === 0
        ? undefined
        : dependsOn.map((dependency) => byName(deployment.captured, dependency).resource),
      `${name}: dependsOn`,
    )
    assert.match(state.provider, /pulumi:providers:vault::vault/)
  }

  lifecycle("kv")
  lifecycle("kv-config", { dependsOn: ["kv"] })
  lifecycle("human-admin-policy", { dependsOn: ["kv"] })
  lifecycle("external-secrets-token-self-policy", { protect: true })
  lifecycle("external-secrets-kubernetes-role-hub-a", { protect: true })
  lifecycle("kubernetes-auth-backend-indigo", { protect: true })
  lifecycle("kubernetes-auth-backend-config-indigo", {
    protect: true,
    dependsOn: ["kubernetes-auth-backend-indigo"],
  })
  lifecycle("external-secrets-policy-indigo-bootstrap-smoke-test", {
    dependsOn: ["kv"],
  })
  lifecycle("external-secrets-token-self-policy-indigo", { protect: true })
  lifecycle("external-secrets-kubernetes-role-indigo", {
    protect: true,
    dependsOn: [
      "kubernetes-auth-backend-config-indigo",
      "external-secrets-policy-indigo-bootstrap-smoke-test",
      "external-secrets-token-self-policy-indigo",
    ],
  })
  lifecycle("audit")

  for (const key of Object.keys(externalPolicyNames)) {
    lifecycle(`external-secrets-policy-${key}`, { dependsOn: ["kv"] })
  }
  for (const key of issuerKeys) {
    lifecycle(`pki-issuer-role-${key}`, { protect: true })
    lifecycle(`pki-issuer-policy-${key}`, {
      protect: true,
      dependsOn: [`pki-issuer-role-${key}`],
    })
  }
  for (const key of [
    "gatewayCaddy",
    "postgresKnoxListener",
    "proxmoxListener",
    "rustfsKhaosListener",
    "vaultListener",
  ] as const) {
    lifecycle(`pki-issuer-approle-${key}`, {
      protect: true,
      dependsOn: [`pki-issuer-role-${key}`, `pki-issuer-policy-${key}`],
    })
  }
  lifecycle("pki-issuer-kubernetes-role-hubATraefikOrigin", {
    protect: true,
    dependsOn: [
      "pki-issuer-role-hubATraefikOrigin",
      "pki-issuer-policy-hubATraefikOrigin",
      "external-secrets-token-self-policy",
    ],
  })
  lifecycle("pki-issuer-kubernetes-role-indigoGatewayOrigin", {
    protect: true,
    dependsOn: [
      "pki-issuer-role-indigoGatewayOrigin",
      "pki-issuer-policy-indigoGatewayOrigin",
      "external-secrets-token-self-policy-indigo",
    ],
  })

  assert.deepEqual(byName(resources, "kv").inputs, {
    description: "Homelab KV v2 secrets managed by Vault.",
    options: { version: "2" },
    path: "kv",
    type: "kv",
  })
  assert.deepEqual(byName(resources, "kv-config").inputs, {
    casRequired: false,
    maxVersions: 10,
    mount: "kv",
  })
  assert.equal(byName(resources, "human-admin-policy").inputs.name, "homelab-human-admin")

  for (const [key, policyName] of Object.entries(externalPolicyNames)) {
    const policy = byName(resources, `external-secrets-policy-${key}`)
    assert.equal(policy.inputs.name, policyName)
    assert.match(policy.inputs.policy, /path "kv\/data\//)
    assert.match(policy.inputs.policy, /path "kv\/metadata\//)
  }

  const externalRole = byName(resources, "external-secrets-kubernetes-role-hub-a")
  assert.deepEqual(
    {
      backend: externalRole.inputs.backend,
      roleName: externalRole.inputs.roleName,
      boundServiceAccountNames: externalRole.inputs.boundServiceAccountNames,
      boundServiceAccountNamespaces: externalRole.inputs.boundServiceAccountNamespaces,
      tokenExplicitMaxTtl: externalRole.inputs.tokenExplicitMaxTtl,
      tokenMaxTtl: externalRole.inputs.tokenMaxTtl,
      tokenNoDefaultPolicy: externalRole.inputs.tokenNoDefaultPolicy,
      tokenNumUses: externalRole.inputs.tokenNumUses,
      tokenTtl: externalRole.inputs.tokenTtl,
      tokenType: externalRole.inputs.tokenType,
    },
    {
      backend: "kubernetes",
      roleName: "hub-a-external-secrets",
      boundServiceAccountNames: ["external-secrets"],
      boundServiceAccountNamespaces: ["external-secrets"],
      tokenExplicitMaxTtl: 3600,
      tokenMaxTtl: 3600,
      tokenNoDefaultPolicy: true,
      tokenNumUses: 0,
      tokenTtl: 1200,
      tokenType: "service",
    },
  )

  assert.deepEqual(byName(resources, "kubernetes-auth-backend-indigo").inputs, {
    description: "Kubernetes authentication for the isolated Indigo cluster.",
    path: "kubernetes-indigo",
    type: "kubernetes",
  })

  const indigoAuthConfig = byName(resources, "kubernetes-auth-backend-config-indigo")
  assert.equal(indigoAuthConfig.inputs.backend, "kubernetes-indigo")
  assert.equal(indigoAuthConfig.inputs.disableLocalCaJwt, true)
  assert.equal(indigoAuthConfig.inputs.kubernetesHost, "https://10.10.80.10:6443")
  assert.match(indigoAuthConfig.inputs.kubernetesCaCert, /BEGIN CERTIFICATE/)
  assert.equal(indigoAuthConfig.inputs.tokenReviewerJwt, undefined)

  const indigoRole = byName(resources, "external-secrets-kubernetes-role-indigo")
  assert.deepEqual(indigoRole.inputs.boundServiceAccountNames, ["external-secrets"])
  assert.deepEqual(indigoRole.inputs.boundServiceAccountNamespaces, ["external-secrets"])
  assert.equal(indigoRole.inputs.backend, "kubernetes-indigo")
  assert.equal(indigoRole.inputs.roleName, "indigo-external-secrets")
  assert.equal(indigoRole.inputs.tokenNoDefaultPolicy, true)
  assert.deepEqual(indigoRole.inputs.tokenPolicies, [
    "indigo-external-secrets-bootstrap-smoke-test",
    "indigo-external-secrets-token-self",
  ])

  for (const key of issuerKeys) {
    const config = vault.pkiIssuers[key]
    const role = byName(resources, `pki-issuer-role-${key}`)
    assert.deepEqual(
      {
        backend: role.inputs.backend,
        name: role.inputs.name,
        allowedDomains: role.inputs.allowedDomains,
        allowAnyName: role.inputs.allowAnyName,
        allowIpSans: role.inputs.allowIpSans,
        allowSubdomains: role.inputs.allowSubdomains,
        allowWildcardCertificates: role.inputs.allowWildcardCertificates,
        clientFlag: role.inputs.clientFlag,
        enforceHostnames: role.inputs.enforceHostnames,
        extKeyUsages: role.inputs.extKeyUsages,
        generateLease: role.inputs.generateLease,
        keyBits: role.inputs.keyBits,
        keyType: role.inputs.keyType,
        maxTtl: role.inputs.maxTtl,
        serverFlag: role.inputs.serverFlag,
        ttl: role.inputs.ttl,
      },
      {
        backend: "pki_int",
        name: config.roleName,
        allowedDomains: [...config.allowedDomains],
        allowAnyName: false,
        allowIpSans: false,
        allowSubdomains: false,
        allowWildcardCertificates: false,
        clientFlag: false,
        enforceHostnames: true,
        extKeyUsages: ["ServerAuth"],
        generateLease: config.generateLease,
        keyBits: 2048,
        keyType: "rsa",
        maxTtl: "2592000",
        serverFlag: true,
        ttl: "2592000",
      },
    )
  }

  for (const key of [
    "gatewayCaddy",
    "postgresKnoxListener",
    "proxmoxListener",
    "rustfsKhaosListener",
    "vaultListener",
  ] as const) {
    const config = vault.pkiIssuers[key].appRole!
    const appRole = byName(resources, `pki-issuer-approle-${key}`)
    assert.equal(appRole.inputs.roleName, config.roleName)
    assert.equal(appRole.inputs.roleId, config.roleId)
    assert.equal(appRole.inputs.tokenType, "batch")
    assert.equal(appRole.inputs.tokenTtl, 900)
    assert.equal(appRole.inputs.tokenMaxTtl, 900)
    assert.equal(appRole.inputs.tokenExplicitMaxTtl, 900)
    assert.equal(appRole.inputs.tokenNoDefaultPolicy, true)
    assert.deepEqual(appRole.inputs.secretIdBoundCidrs, [...config.secretIdBoundCidrs])
    assert.deepEqual(appRole.inputs.tokenBoundCidrs, [...config.tokenBoundCidrs])
  }

  const traefikRole = byName(resources, "pki-issuer-kubernetes-role-hubATraefikOrigin")
  assert.equal(traefikRole.inputs.roleName, "hub-a-traefik-origin-issuer")
  assert.deepEqual(traefikRole.inputs.boundServiceAccountNames, ["traefik-origin-issuer"])
  assert.deepEqual(traefikRole.inputs.boundServiceAccountNamespaces, ["traefik"])
  assert.deepEqual(traefikRole.inputs.tokenPolicies, [
    "homelab-pki-hub-a-traefik-origin",
    "hub-a-external-secrets-token-self",
  ])

  const indigoGatewayRole = byName(
    resources,
    "pki-issuer-kubernetes-role-indigoGatewayOrigin",
  )
  assert.equal(indigoGatewayRole.inputs.backend, "kubernetes-indigo")
  assert.equal(indigoGatewayRole.inputs.roleName, "indigo-gateway-origin-issuer")
  assert.deepEqual(indigoGatewayRole.inputs.boundServiceAccountNames, [
    "gateway-origin-issuer",
  ])
  assert.deepEqual(indigoGatewayRole.inputs.boundServiceAccountNamespaces, ["gateway-system"])
  assert.deepEqual(indigoGatewayRole.inputs.tokenPolicies, [
    "homelab-pki-indigo-gateway-origin",
    "indigo-external-secrets-token-self",
  ])

  assert.deepEqual(byName(resources, "audit").inputs, {
    description: "Homelab Vault audit log.",
    options: {
      file_path: "/var/lib/vault/audit.log",
    },
    path: "file",
    type: "file",
  })
})
