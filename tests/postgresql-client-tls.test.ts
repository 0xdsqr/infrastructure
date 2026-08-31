import { strict as assert } from "node:assert"
import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const rootCaFingerprint =
  "5E:CA:96:D8:61:31:42:40:2A:54:C3:EC:B7:B5:D1:E7:E2:51:7A:A2:77:E5:8C:F6:08:81:45:2C:96:80:82:4F"
const rootCaMountPath = "/etc/dsqr/pki/dsqr-home-root-ca.pem"

test("hub-a distributes the expected home root CA to application namespaces", () => {
  const manifest = readFileSync(
    new URL(
      "../gitops/components/cluster-foundation/overlays/hub-a/internal-ca.configmaps.yaml",
      import.meta.url,
    ),
    "utf8",
  )
  const certificates = manifest.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  )

  assert.equal(certificates?.length, 3)
  assert.equal((manifest.match(/name: dsqr-home-root-ca/g) ?? []).length, 3)

  for (const namespace of ["dsqr", "fidara", "twt"]) {
    assert.match(manifest, new RegExp(`namespace: ${namespace}`))
  }

  for (const indentedCertificate of certificates ?? []) {
    const certificate = new X509Certificate(
      indentedCertificate
        .split("\n")
        .map((line) => line.trim())
        .join("\n"),
    )

    assert.equal(certificate.fingerprint256, rootCaFingerprint)
    assert.equal(certificate.ca, true)
  }

  const bootstrapProject = readFileSync(
    new URL("../gitops/clusters/hub-a/bootstrap/bootstrap.appproject.yaml", import.meta.url),
    "utf8",
  )

  for (const namespace of ["argocd", "dsqr", "fidara", "twt"]) {
    assert.match(bootstrapProject, new RegExp(`namespace: ${namespace}`))
  }
  assert.match(bootstrapProject, /group: ""\n      kind: ConfigMap/)
})

test("all hub-a Node workloads load the additional trust anchor", () => {
  for (const app of ["dotdev-web", "dotdev-studio", "dotdev-labs", "twt-web", "twt-admin"]) {
    const values = readFileSync(
      new URL(`../gitops/components/${app}/overlays/hub-a/values-overrides.yaml`, import.meta.url),
      "utf8",
    )

    assert.match(
      values,
      /additionalTrustedCa:\n  enabled: true\n  configMapName: dsqr-home-root-ca/,
    )
  }

  for (const app of ["twt-web", "twt-admin"]) {
    const values = readFileSync(
      new URL(`../gitops/components/${app}/overlays/hub-a/values-overrides.yaml`, import.meta.url),
      "utf8",
    )

    assert.match(values, /DATABASE_SSL: require/)
    assert.match(values, /DATABASE_SSL_REJECT_UNAUTHORIZED: "true"/)
  }
})

test("Fidara verifies PostgreSQL through Knox and the exact home CA", () => {
  const values = readFileSync(
    new URL("../gitops/components/fidara/overlays/hub-a/values-overrides.yaml", import.meta.url),
    "utf8",
  )

  assert.match(values, /cidr: 10\.10\.30\.109\/32/)
  assert.doesNotMatch(values, /10\.10\.30\.107/)
  assert.ok(values.includes(`NODE_EXTRA_CA_CERTS: ${rootCaMountPath}`))
  assert.ok(values.includes(`PGSSLROOTCERT: ${rootCaMountPath}`))
  assert.equal((values.match(/name: dsqr-home-root-ca/g) ?? []).length, 6)
})
