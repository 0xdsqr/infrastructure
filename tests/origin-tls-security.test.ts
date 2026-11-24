import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { cloudflare } from "../infra/cloudflare/config.ts"
import { vault } from "../infra/vault/config.ts"

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

test("Indigo Argo webhook uses the private Gateway identity and an exact public route", () => {
  const cloudflareRule = cloudflare.ingressRules.find(
    (rule) => rule.hostname === "argocd-hooks-indigo.dsqr.dev",
  )
  const route = readFileSync(
    new URL(
      "../gitops/components/argocd/access/overlays/indigo/github-webhook.httproute.yaml",
      import.meta.url,
    ),
    "utf8",
  )
  const externalSecret = readFileSync(
    new URL(
      "../gitops/components/argocd/access/overlays/indigo/github-webhook.externalsecret.yaml",
      import.meta.url,
    ),
    "utf8",
  )

  assert.equal(cloudflareRule?.service, "https://10.10.80.200")
  assert.deepEqual(cloudflareRule?.originRequest, {
    http2Origin: false,
    httpHostHeader: "argocd-hooks-indigo.dsqr.dev",
    originServerName: "argocd.indigo.home.arpa",
  })
  assert.ok(vault.pkiIssuers.indigoGatewayOrigin.allowedDomains.includes("argocd.indigo.home.arpa"))
  assert.match(route, /method: POST/)
  assert.match(route, /type: Exact\n\s+value: \/api\/webhook/)
  assert.match(
    externalSecret,
    /key: dsqr-labs\/clusters\/indigo\/platform\/argocd\/webhooks\/github/,
  )
  assert.doesNotMatch(externalSecret, /homelab/)
})
