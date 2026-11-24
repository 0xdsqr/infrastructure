import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { test } from "node:test"
import { parseAllDocuments } from "yaml"

const rootCaFingerprint =
  "5E:CA:96:D8:61:31:42:40:2A:54:C3:EC:B7:B5:D1:E7:E2:51:7A:A2:77:E5:8C:F6:08:81:45:2C:96:80:82:4F"
test("Indigo application namespaces retain the verified database root CA", () => {
  for (const [component, namespace] of [
    ["dotdev", "dsqr"],
    ["twt", "twt"],
  ]) {
    const resources = parseAllDocuments(
      execFileSync(
        "kubectl",
        ["kustomize", `gitops/components/${component}/database-trust/overlays/indigo`],
        { encoding: "utf8" },
      ),
    )
      .map((d) => d.toJSON())
      .filter(Boolean)
    const ca = resources.find(
      (r) => r.kind === "ConfigMap" && r.metadata.name === "dsqr-home-root-ca",
    )
    assert.equal(ca.metadata.namespace, namespace)
    const pem = Object.values(ca.data).find((v) => String(v).includes("BEGIN CERTIFICATE"))
    const certificate = new X509Certificate(String(pem))
    assert.equal(certificate.fingerprint256, rootCaFingerprint)
    assert.equal(certificate.ca, true)
  }
})
