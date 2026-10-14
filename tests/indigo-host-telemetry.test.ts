import assert from "node:assert/strict"
import test from "node:test"
import { vault } from "../infra/vault/config.ts"
import { indigoHostTelemetryIssuers, indigoHostTelemetryNodes } from "../infra/vault/indigo-host-telemetry.ts"

test("host telemetry enrolls exactly three controls and six workers, each independently", () => {
  const suffixes = ["control-01", "control-02", "control-03", "worker-01", "worker-02", "worker-03", "worker-04", "worker-05", "worker-06"]
  assert.deepEqual(indigoHostTelemetryNodes.map(n => n.host), suffixes.map(s => `srv-lx-k8s-indigo-${s}`))
  assert.deepEqual(indigoHostTelemetryNodes.map(n => n.address), suffixes.map((_, i) => `10.10.80.${100 + i}`))
  assert.equal(Object.keys(indigoHostTelemetryIssuers).length, 9)
  for (const { host, address } of indigoHostTelemetryNodes) {
    const key = `indigoHostTelemetry-${host}`
    const issuer = indigoHostTelemetryIssuers[key]!
    assert.equal((vault.pkiIssuers as Record<string, unknown>)[key], issuer)
    assert.deepEqual(issuer.allowedDomains, [`${host}.telemetry-client.home.arpa`])
    assert.equal(issuer.certificatePurpose, "client")
    assert.equal(issuer.allowWildcardCertificates, false)
    assert.equal(issuer.generateLease, false)
    assert.equal(issuer.ttlHours, 720)
    assert.equal(issuer.maxTtlHours, 720)
    assert.deepEqual(issuer.appRole.secretIdBoundCidrs, [`${address}/32`])
    assert.deepEqual(issuer.appRole.tokenBoundCidrs, [`${address}/32`])
    assert.equal(issuer.appRole.tokenTtlSeconds, 900)
    assert.equal(issuer.appRole.tokenMaxTtlSeconds, 900)
    assert.equal(issuer.appRole.tokenExplicitMaxTtlSeconds, 900)
    assert.equal(issuer.appRole.secretIdNumUses, 0)
    assert.equal(issuer.appRole.secretIdTtlSeconds, 0)
    assert.equal(issuer.appRole.tokenNumUses, 0)
  }
  assert.equal(new Set(Object.values(indigoHostTelemetryIssuers).map(i => i.appRole.roleName)).size, 9)
  assert.equal(new Set(Object.values(indigoHostTelemetryIssuers).map(i => i.policyName)).size, 9)
})

test("host enrollment does not reuse the in-cluster collector identity or Kubernetes login", () => {
  const cluster = vault.pkiIssuers.indigoTelemetryClient
  assert.deepEqual(cluster.allowedDomains, ["indigo.telemetry-client.home.arpa"])
  assert.equal(cluster.kubernetesAuthRole.roleName, "indigo-telemetry-client-issuer")
  for (const issuer of Object.values(indigoHostTelemetryIssuers)) {
    assert.ok(!issuer.allowedDomains.includes(cluster.allowedDomains[0]!))
    assert.equal("kubernetesAuthRole" in issuer, false)
    assert.equal("secretId" in issuer.appRole, false)
  }
})

test("host policies use dsqr-labs while roles use the existing Indigo naming convention", () => {
  const suffixes = ["control-01", "control-02", "control-03", "worker-01", "worker-02", "worker-03", "worker-04", "worker-05", "worker-06"]
  for (const suffix of suffixes) {
    const host = `srv-lx-k8s-indigo-${suffix}`
    const issuer = indigoHostTelemetryIssuers[`indigoHostTelemetry-${host}`]!
    assert.equal(issuer.policyName, `dsqr-labs-pki-indigo-${suffix}-telemetry-client`)
    assert.equal(issuer.roleName, `indigo-${suffix}-telemetry-client`)
    assert.equal(issuer.appRole.roleName, `indigo-${suffix}-telemetry-renewer`)
    assert.deepEqual(issuer.allowedDomains, [`${host}.telemetry-client.home.arpa`])
  }
})
