import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { parseAllDocuments } from "yaml"

// Supply the cached pinned chart to exercise upstream Helm tpl without network access.
const chart = process.env.ARGOCD_TEST_CHART
test("Argo Helm renders legacy ingress only for hub-a", { skip: !chart }, () => {
  for (const cluster of ["hub-a", "indigo"]) {
    const resources = parseAllDocuments(execFileSync("helm", [
      "template", "argocd", chart!, "--namespace", "argocd",
      "--values", "gitops/components/argocd/base/values-common.yaml",
      "--values", `gitops/components/argocd/overlays/${cluster}/values-overrides.yaml`,
    ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })).map(document => document.toJSON()).filter(Boolean)
    if (cluster === "indigo") {
      const settings = resources.find(resource => resource.kind === "ConfigMap" && resource.metadata.name === "argocd-cm")
      assert.equal(settings.data["users.anonymous.enabled"], "false")
      assert.equal(settings.data["admin.enabled"], "true")
    }
    const policy = resources.find(resource => resource.kind === "NetworkPolicy" && resource.metadata.name === "argocd-allow-server-ingress")
    assert.ok(policy)
    const namespaces = policy.spec.ingress.flatMap(rule => rule.from.map(source => source.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"]))
    assert.equal(namespaces.includes("traefik"), cluster === "hub-a")
    assert.ok(namespaces.includes("observability"))
    assert.equal(resources.some(resource => resource.kind === "Ingress"), cluster === "hub-a")
    assert.deepEqual(policy.spec.ingress.flatMap(rule => rule.ports.map(port => port.port)), cluster === "hub-a" ? [8080, 8083] : [8083])
  }
})
