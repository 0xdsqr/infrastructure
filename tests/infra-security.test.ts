import { strict as assert } from "node:assert"
import { test } from "node:test"

import { Effect } from "effect"

import { requireConfigValueEffect } from "@dsqr/pulumi-shared"

import {
  cloudflareZoneSecuritySettings,
  validateCloudflareIngressRuleEffect,
} from "../packages/pulumi/cloudflare/src/index.ts"
import {
  loadProxmoxConnectionConfigEffect,
  validateProxmoxTransportEffect,
} from "../packages/pulumi/proxmox/src/config.ts"
import {
  hardenedTailnetKeyDefaults,
  tailnetPolicySafetyDefaults,
} from "../packages/pulumi/tailscale/src/index.ts"
import {
  renderKvV2ReadPolicy,
  renderPkiIssuePolicy,
  renderTokenSelfPolicy,
  validateExternalSecretsPoliciesEffect,
  validateExternalSecretsKubernetesRoleEffect,
  validatePkiIssuerInventoryEffect,
  validateVaultTransportEffect,
} from "../packages/pulumi/vault/src/index.ts"
import { cloudflare } from "../infra/cloudflare/config.ts"
import { tailscale } from "../infra/tailscale/config.ts"
import { vault } from "../infra/vault/config.ts"

test("missing Pulumi configuration errors explain every accepted source", () => {
  const error = Effect.runSync(
    Effect.flip(
      requireConfigValueEffect(undefined, "Vault token", [
        "pulumi config set --secret vault:token <token>",
        "VAULT_TOKEN",
      ]),
    ),
  )

  assert.equal(
    error.message,
    "Missing Vault token; configure one of: pulumi config set --secret vault:token <token>, VAULT_TOKEN.",
  )
})

test("Proxmox verifies TLS unless insecure mode is explicitly enabled", () => {
  const config = {
    get: (name: string) => (name === "endpoint" ? "https://proxmox.example.test:8006" : undefined),
    getBoolean: () => undefined,
    getSecret: (name: string) => (name === "apiToken" ? "user@realm!token=redacted" : undefined),
  }

  const secure = Effect.runSync(loadProxmoxConnectionConfigEffect({ config }))
  assert.equal(secure.insecure, false)

  const localConfig = {
    ...config,
    get: (name: string) => (name === "endpoint" ? "http://127.0.0.1:8006" : undefined),
  }
  const explicitlyInsecureLocalDev = Effect.runSync(
    loadProxmoxConnectionConfigEffect({
      config: localConfig,
      environment: {
        insecure: true,
        allowInsecureLocalDev: true,
      },
    }),
  )
  assert.equal(explicitlyInsecureLocalDev.insecure, true)

  const remoteHttp = Effect.runSync(
    Effect.flip(validateProxmoxTransportEffect("http://proxmox.example.test:8006", false, true)),
  )
  assert.match(remoteHttp.message, /requires HTTPS/)

  const unverifiedRemoteTls = Effect.runSync(
    Effect.flip(validateProxmoxTransportEffect("https://proxmox.example.test:8006", true, false)),
  )
  assert.match(unverifiedRemoteTls.message, /cannot be disabled/)
})

test("Vault requires verified HTTPS except for explicit loopback-only development", () => {
  Effect.runSync(validateVaultTransportEffect("https://vault.example.test:8200", false, false))
  Effect.runSync(validateVaultTransportEffect("http://127.0.0.1:8200", false, true))
  Effect.runSync(validateVaultTransportEffect("https://localhost:8200", true, true))

  const remoteHttp = Effect.runSync(
    Effect.flip(validateVaultTransportEffect("http://vault.example.test:8200", false, true)),
  )
  assert.match(remoteHttp.message, /requires HTTPS/)

  const unverifiedRemoteTls = Effect.runSync(
    Effect.flip(validateVaultTransportEffect("https://vault.example.test:8200", true, false)),
  )
  assert.match(unverifiedRemoteTls.message, /cannot be disabled/)

  const implicitLocalHttp = Effect.runSync(
    Effect.flip(validateVaultTransportEffect("http://localhost:8200", false, false)),
  )
  assert.match(implicitLocalHttp.message, /requires HTTPS/)
})

test("Cloudflare ingress verifies HTTPS origins and documents temporary HTTP exceptions", () => {
  for (const rule of cloudflare.ingressRules) {
    Effect.runSync(validateCloudflareIngressRuleEffect(rule))
    const originRequest = (rule as { readonly originRequest?: { readonly noTlsVerify?: unknown } })
      .originRequest
    assert.notEqual(originRequest?.noTlsVerify, true)
  }

  const undocumentedHttp = Effect.runSync(
    Effect.flip(
      validateCloudflareIngressRuleEffect({
        hostname: "insecure.example.test",
        zone: "example",
        service: "http://192.168.2.10:8080",
      }),
    ),
  )
  assert.match(undocumentedHttp.message, /requires a specific migration justification/)

  const publicHttp = Effect.runSync(
    Effect.flip(
      validateCloudflareIngressRuleEffect({
        hostname: "public-http.example.test",
        zone: "example",
        service: "http://198.51.100.10:8080",
        insecureOriginReason:
          "This reason is deliberately long enough but must not permit a public cleartext origin.",
      }),
    ),
  )
  assert.match(publicHttp.message, /must be loopback, RFC1918, ULA/)

  const unverifiedHttps = Effect.runSync(
    Effect.flip(
      validateCloudflareIngressRuleEffect({
        hostname: "unverified.example.test",
        zone: "example",
        service: "https://192.0.2.10",
        originRequest: { noTlsVerify: true } as never,
      }),
    ),
  )
  assert.match(unverifiedHttps.message, /cannot disable TLS verification/)
})

test("Cloudflare zones enforce HTTPS, verified origins, and modern TLS", () => {
  for (const policy of Object.values(cloudflare.zoneSecurity)) {
    assert.deepEqual(cloudflareZoneSecuritySettings(policy), {
      alwaysUseHttps: {
        settingId: "always_use_https",
        value: "on",
      },
      automaticHttpsRewrites: {
        settingId: "automatic_https_rewrites",
        value: "on",
      },
      minimumTlsVersion: {
        settingId: "min_tls_version",
        value: "1.2",
      },
      tls13: {
        settingId: "tls_1_3",
        value: "on",
      },
      strictOriginTls: {
        settingId: "ssl",
        value: "strict",
      },
    })
  }
})

test("Tailscale machine enrollment keys are hardened while the live ACL remains compatible", () => {
  assert.deepEqual(hardenedTailnetKeyDefaults, {
    reusable: false,
    ephemeral: false,
    preauthorized: false,
    expiry: 3_600,
    recreateIfInvalid: "never",
  })
  assert.deepEqual(tailnetPolicySafetyDefaults, {
    overwriteExistingContent: false,
    resetAclOnDestroy: false,
  })
  assert.ok(!("darwinWorkstation" in tailscale.keySpecs))

  const adminUser = "admin@example.test"
  const policy = tailscale.createPolicy({ adminUser })
  assert.deepEqual(policy.autoApprovers.exitNode, [tailscale.tags.role.exitNode])
  assert.ok(policy.grants.some((grant) => grant.src[0] === tailscale.tags.role.workstation))
  assert.deepEqual(policy.hosts, {
    "beacon-observability": tailscale.hosts.beaconObservability,
  })
  assert.ok(
    policy.grants.some(
      (grant) =>
        grant.src[0] === tailscale.tags.role.mail &&
        grant.dst[0] === "beacon-observability" &&
        grant.ip.join(",") === "tcp:9090,tcp:3100",
    ),
  )
  assert.ok(
    policy.grants.some(
      (grant) =>
        grant.src[0] === tailscale.tags.role.mail &&
        grant.dst[0] === tailscale.tags.role.backup &&
        grant.ip.join(",") === "tcp:22",
    ),
  )
})

test("External Secrets policies use unique exact paths and exclude infrastructure credentials", () => {
  Effect.runSync(
    validateExternalSecretsPoliciesEffect(vault.policies.externalSecrets, vault.secretPaths),
  )

  const readPaths = Object.values(vault.policies.externalSecrets).flatMap(
    (policy) => policy.readPaths,
  )
  assert.equal(new Set(readPaths).size, readPaths.length)
  assert.ok(
    Object.values(vault.policies.externalSecrets).every((policy) => policy.readPaths.length === 1),
  )
  assert.ok(readPaths.every((path) => !path.includes("*")))
  assert.ok(readPaths.every((path) => !path.startsWith("homelab/infra/")))
  assert.ok(
    Object.values(vault.policies.externalSecrets).every((policy) =>
      policy.name.startsWith("hub-a-external-secrets-"),
    ),
  )

  for (const policy of Object.values(vault.policies.externalSecrets)) {
    const rendered = renderKvV2ReadPolicy(vault.kv.path, policy.readPaths)
    assert.doesNotMatch(rendered, /\*/)
    assert.doesNotMatch(rendered, /"list"/)
  }

  const wildcardPolicy = Effect.runSync(
    Effect.flip(
      validateExternalSecretsPoliciesEffect(
        {
          broad: {
            name: "broad",
            readPaths: ["homelab/apps/*"],
          },
        },
        vault.secretPaths,
      ),
    ),
  )
  assert.match(wildcardPolicy.message, /cannot use wildcard path/)
})

test("hub-a External Secrets auth is exact and least-privilege after migration", () => {
  Effect.runSync(validateExternalSecretsKubernetesRoleEffect(vault.externalSecretsKubernetesRole))

  assert.equal(vault.externalSecretsKubernetesRole.roleName, "hub-a-external-secrets")
  assert.equal(
    vault.externalSecretsKubernetesRole.tokenSelfPolicyName,
    "hub-a-external-secrets-token-self",
  )
  const tokenSelfPolicy = renderTokenSelfPolicy()
  assert.match(tokenSelfPolicy, /auth\/token\/lookup-self[\s\S]*\["read"\]/)
  assert.match(tokenSelfPolicy, /auth\/token\/renew-self[\s\S]*\["update"\]/)
  assert.match(tokenSelfPolicy, /auth\/token\/revoke-self[\s\S]*\["update"\]/)
  assert.doesNotMatch(tokenSelfPolicy, /"create"|"delete"|"list"|"sudo"/)
  assert.deepEqual(vault.externalSecretsKubernetesRole.boundServiceAccountNames, [
    "external-secrets",
  ])
  assert.deepEqual(vault.externalSecretsKubernetesRole.boundServiceAccountNamespaces, [
    "external-secrets",
  ])

  assert.equal("legacyExternalSecrets" in vault.policies, false)
  assert.equal("dotdevLabs" in vault.secretPaths, false)
  assert.equal("dotdevLabs" in vault.policies.externalSecrets, false)

  const wildcardBinding = Effect.runSync(
    Effect.flip(
      validateExternalSecretsKubernetesRoleEffect({
        ...vault.externalSecretsKubernetesRole,
        boundServiceAccountNamespaces: ["*"],
      }),
    ),
  )
  assert.match(wildcardBinding.message, /bind exact service accounts and namespaces/)
})

test("Vault PKI issuers are exact, least-privilege, and do not persist SecretIDs", () => {
  Effect.runSync(validatePkiIssuerInventoryEffect(vault.pkiIssuers))

  const issuers = Object.values(vault.pkiIssuers)
  assert.equal(new Set(issuers.map((issuer) => issuer.roleName)).size, issuers.length)
  assert.equal(new Set(issuers.map((issuer) => issuer.policyName)).size, issuers.length)

  for (const issuer of issuers) {
    assert.ok(issuer.allowedDomains.length > 0)
    assert.ok(issuer.allowedDomains.every((domain) => !domain.includes("*")))
    assert.equal(issuer.backend, "pki_int")
    assert.ok(issuer.ttlHours <= issuer.maxTtlHours)
    assert.ok(issuer.maxTtlHours <= 720)

    const policy = renderPkiIssuePolicy(issuer.backend, issuer.roleName)
    assert.match(policy, new RegExp(`path "pki_int/issue/${issuer.roleName}"`))
    assert.doesNotMatch(policy, /pki_int\/issue\/\*/)
    assert.doesNotMatch(policy, /"list"/)
    assert.doesNotMatch(policy, /auth\/token/)
    assert.doesNotMatch(policy, /\/sign\//)
    assert.doesNotMatch(policy, /\/issuer\//)

    if ("appRole" in issuer && issuer.appRole) {
      assert.ok(issuer.appRole.secretIdBoundCidrs.length > 0)
      assert.ok(issuer.appRole.tokenBoundCidrs.length > 0)
      assert.ok(!("secretId" in issuer.appRole))
    }
  }

  assert.deepEqual(vault.pkiIssuers.proxmoxListener.allowedDomains, [
    "proxmox.dell-r730xd.home.arpa",
  ])
  assert.deepEqual(vault.pkiIssuers.postgresKnoxListener.allowedDomains, [
    "postgres.service.home.arpa",
  ])
  assert.deepEqual(vault.pkiIssuers.postgresKnoxListener.appRole.secretIdBoundCidrs, [
    "10.10.30.109/32",
  ])
  assert.deepEqual(vault.pkiIssuers.postgresKnoxListener.appRole.tokenBoundCidrs, [
    "10.10.30.109/32",
  ])
  assert.ok(vault.pkiIssuers.gatewayCaddy.allowedDomains.includes("exo.service.home.arpa"))
  assert.ok(!("appRole" in vault.pkiIssuers.hubATraefikOrigin))

  const wildcardDomain = Effect.runSync(
    Effect.flip(
      validatePkiIssuerInventoryEffect({
        unsafe: {
          ...vault.pkiIssuers.vaultListener,
          allowedDomains: ["*.home.arpa"],
        },
      }),
    ),
  )
  assert.match(wildcardDomain.message, /exact lowercase DNS names/)

  const globallyBoundAppRole = Effect.runSync(
    Effect.flip(
      validatePkiIssuerInventoryEffect({
        unsafe: {
          ...vault.pkiIssuers.vaultListener,
          appRole: {
            ...vault.pkiIssuers.vaultListener.appRole,
            secretIdBoundCidrs: ["0.0.0.0/0"],
          },
        },
      }),
    ),
  )
  assert.match(globallyBoundAppRole.message, /explicit, non-global source CIDRs/)
})
