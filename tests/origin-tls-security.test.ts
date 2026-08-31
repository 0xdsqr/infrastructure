import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { Effect } from "effect"

import { validatePkiIssuerInventoryEffect } from "../packages/pulumi/vault/src/index.ts"
import { cloudflare } from "../infra/cloudflare/config.ts"
import { vault } from "../infra/vault/config.ts"

test("Cloudflare Traefik origins use exact SNI names covered by the Vault issuer", () => {
  const allowedDomains = new Set(vault.pkiIssuers.hubATraefikOrigin.allowedDomains)
  const traefikRules = cloudflare.ingressRules.filter(
    (rule) => rule.service === "https://10.10.30.200",
  )

  assert.ok(traefikRules.length > 0)

  for (const rule of traefikRules) {
    const originRequest = (
      rule as {
        readonly originRequest?: {
          readonly httpHostHeader?: string
          readonly originServerName?: string
        }
      }
    ).originRequest

    assert.equal(originRequest?.httpHostHeader, rule.hostname)
    assert.equal(originRequest?.originServerName, rule.hostname)
    assert.ok(allowedDomains.has(rule.hostname))
  }
})

test("Cloudflare RustFS origins verify the dedicated Vault listener identity", () => {
  const rustfsRules = cloudflare.ingressRules.filter(
    (rule) => rule.service === "https://10.10.30.107:9000",
  )

  assert.deepEqual(rustfsRules.map((rule) => rule.hostname).sort(), ["cdn.dsqr.dev", "s3.dsqr.dev"])

  for (const rule of rustfsRules) {
    assert.deepEqual(rule.originRequest, {
      http2Origin: false,
      httpHostHeader: rule.hostname,
      originServerName: "rustfs.service.home.arpa",
    })
  }

  assert.deepEqual(vault.pkiIssuers.rustfsKhaosListener.allowedDomains, [
    "rustfs.service.home.arpa",
  ])
  assert.equal(
    vault.pkiIssuers.rustfsKhaosListener.appRole.roleId,
    "e8b1c7b0-da79-456a-b59b-60c9c849386b",
  )
})

test("Traefik certificate issuance uses a dedicated exact Kubernetes identity", () => {
  const traefikKubernetesAuthRole = vault.pkiIssuers.hubATraefikOrigin.kubernetesAuthRole

  assert.equal(traefikKubernetesAuthRole.roleName, "hub-a-traefik-origin-issuer")
  assert.deepEqual(traefikKubernetesAuthRole.boundServiceAccountNames, ["traefik-origin-issuer"])
  assert.deepEqual(traefikKubernetesAuthRole.boundServiceAccountNamespaces, ["traefik"])

  const wildcardKubernetesBinding = Effect.runSync(
    Effect.flip(
      validatePkiIssuerInventoryEffect({
        unsafe: {
          ...vault.pkiIssuers.hubATraefikOrigin,
          kubernetesAuthRole: {
            ...traefikKubernetesAuthRole,
            boundServiceAccountNamespaces: ["*"],
          },
        },
      }),
    ),
  )

  assert.match(wildcardKubernetesBinding.message, /bind exact service accounts and namespaces/)
})

test("hub-a Traefik declarations pin the VIP and materialize the exact Vault certificate", () => {
  const values = readFileSync(
    new URL("../gitops/components/traefik/overlays/hub-a/values-overrides.yaml", import.meta.url),
    "utf8",
  )
  const generator = readFileSync(
    new URL(
      "../gitops/components/external-secrets-config/base/hub-a-traefik-origin.vaultdynamicsecret.yaml",
      import.meta.url,
    ),
    "utf8",
  )
  const externalSecret = readFileSync(
    new URL(
      "../gitops/components/external-secrets-config/base/hub-a-traefik-origin.externalsecret.yaml",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(values, /metallb\.io\/address-pool: ingress/)
  assert.match(values, /metallb\.io\/loadBalancerIPs: 10\.10\.30\.200/)
  assert.match(values, /secretName: hub-a-traefik-origin-tls/)
  assert.match(generator, /server: https:\/\/vault\.service\.home\.arpa:8200/)
  assert.match(generator, /role: hub-a-traefik-origin-issuer/)
  assert.match(generator, /name: traefik-origin-issuer/)
  assert.match(externalSecret, /type: kubernetes\.io\/tls/)

  for (const domain of vault.pkiIssuers.hubATraefikOrigin.allowedDomains) {
    assert.ok(generator.includes(domain), `Vault certificate generator is missing ${domain}`)
  }
})

test("hub-a owns its cluster-specific private Argo hostname", () => {
  const commonValues = readFileSync(
    new URL("../gitops/components/argocd/base/values-common.yaml", import.meta.url),
    "utf8",
  )
  const hubValues = readFileSync(
    new URL("../gitops/components/argocd/overlays/hub-a/values-overrides.yaml", import.meta.url),
    "utf8",
  )

  assert.doesNotMatch(commonValues, /argocd\.home\.arpa/)
  assert.ok(!vault.pkiIssuers.gatewayCaddy.allowedDomains.includes("argocd.home.arpa"))
  assert.ok(!vault.pkiIssuers.hubATraefikOrigin.allowedDomains.includes("argocd.home.arpa"))
  assert.match(hubValues, /domain: argocd\.hub-a\.home\.arpa/)
  assert.match(hubValues, /hostname: argocd\.hub-a\.home\.arpa/)
})

test("app-of-apps health waits for child sync before advancing waves", () => {
  const commonValues = readFileSync(
    new URL("../gitops/components/argocd/base/values-common.yaml", import.meta.url),
    "utf8",
  )

  assert.match(commonValues, /obj\.status\.sync == nil or obj\.status\.sync\.status ~= "Synced"/)
  assert.match(
    commonValues,
    /obj\.status\.health ~= nil and obj\.status\.health\.status == "Healthy"/,
  )
  assert.match(
    commonValues,
    /obj\.status\.health ~= nil and obj\.status\.health\.status == "Degraded"/,
  )
  assert.match(commonValues, /hs\.status = "Progressing"/)
})

test("Argo GitHub webhook secret has one exact Vault path", () => {
  assert.deepEqual(vault.secretPaths.argocdGithubWebhook, {
    path: "homelab/platform/argocd/webhooks/github",
    description: "Shared HMAC secret for authenticated GitHub webhook deliveries to Argo CD.",
    fields: ["secret"],
  })
  assert.deepEqual(vault.policies.externalSecrets.argocdGithubWebhook, {
    name: "hub-a-external-secrets-argocd-github-webhook",
    readPaths: ["homelab/platform/argocd/webhooks/github"],
  })
})

test("public Argo webhook exposure is authenticated and route-scoped", () => {
  const values = readFileSync(
    new URL("../gitops/components/argocd/overlays/hub-a/values-overrides.yaml", import.meta.url),
    "utf8",
  )
  const externalSecret = readFileSync(
    new URL(
      "../gitops/components/argocd/overlays/hub-a/github-webhook.externalsecret.yaml",
      import.meta.url,
    ),
    "utf8",
  )
  const route = readFileSync(
    new URL(
      "../gitops/components/argocd/overlays/hub-a/github-webhook.traefik.yaml",
      import.meta.url,
    ),
    "utf8",
  )
  const cloudflareRule = cloudflare.ingressRules.find(
    (rule) => rule.hostname === "argocd-hooks-hub-a.dsqr.dev",
  )

  assert.match(values, /githubSecret: "\$argocd-github-webhook:secret"/)
  assert.match(values, /webhook\.maxPayloadSizeMB: "5"/)
  assert.doesNotMatch(values, /webhook\.github\.secret:/)
  assert.match(externalSecret, /key: homelab\/platform\/argocd\/webhooks\/github/)
  assert.match(externalSecret, /property: secret/)
  assert.match(externalSecret, /app\.kubernetes\.io\/part-of: argocd/)
  assert.ok(route.includes("Host(`argocd-hooks-hub-a.dsqr.dev`)"))
  assert.ok(route.includes("Path(`/api/webhook`)"))
  assert.ok(route.includes("Method(`POST`)"))
  assert.match(route, /name: argocd-github-webhook-body-limit/)
  assert.match(route, /maxRequestBodyBytes: 5242880/)
  assert.match(route, /memRequestBodyBytes: 1048576/)
  assert.doesNotMatch(route, /argocd\.hub-a\.home\.arpa/)
  assert.equal(cloudflareRule?.service, "https://10.10.30.200")
  assert.deepEqual(cloudflareRule?.originRequest, {
    http2Origin: false,
    httpHostHeader: "argocd-hooks-hub-a.dsqr.dev",
    originServerName: "argocd-hooks-hub-a.dsqr.dev",
  })
})
