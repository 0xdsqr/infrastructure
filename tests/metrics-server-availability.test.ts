import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments, stringify } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const chart = process.env.METRICS_SERVER_TEST_CHART
const common = "gitops/components/metrics-server/base/values-common.yaml"
const overlay = (cluster: string) => `gitops/components/metrics-server/overlays/${cluster}/values-overrides.yaml`
const values = (cluster: string) => parse(readFileSync(overlay(cluster), "utf8"))
const decode = (text: string) => parseAllDocuments(text, { version: "1.1" }).map(d => d.toJSON()).filter(Boolean)
const kustomize = (path: string) => decode(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" }))
const render = (overrides: unknown) => decode(execFileSync("helm", [
  "template", "metrics-server", chart!, "--namespace", "kube-system", "--kube-version", "1.36.3",
  "-f", common, "-f", "-",
], { input: stringify(overrides), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }))

test("Indigo Metrics Server opts into two spread replicas without relaxing kubelet TLS", () => {
  const v = values("indigo")
  assert.equal(v.replicas, 2)
  assert.deepEqual(v.args, ["--kubelet-certificate-authority=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"])
  assert.deepEqual(v.podDisruptionBudget, { enabled: true, minAvailable: 1 })
  assert.deepEqual(v.updateStrategy, { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } })
  assert.equal(parse(readFileSync(common, "utf8")).replicas, 1)
})

test("pinned Metrics Server chart changes only replica count, spread, strategy and budget", { skip: !chart }, () => {
  const v = values("indigo")
  const before = structuredClone(v)
  for (const field of ["replicas", "updateStrategy", "podDisruptionBudget", "topologySpreadConstraints"]) delete before[field]
  const resources = render(v)
  const original = render(before)
  const deployment = resources.find(o => o.kind === "Deployment")
  const [budget] = resources.filter(o => o.kind === "PodDisruptionBudget")
  assert.equal(resources.length, original.length + 1)
  assert.equal(budget.metadata.namespace, "kube-system")
  assert.equal(budget.spec.minAvailable, 1)
  assert.equal(budget.spec.maxUnavailable, undefined)
  assert.deepEqual(budget.spec.selector, deployment.spec.selector)
  assert.equal(deployment.spec.replicas, 2)
  assert.deepEqual(deployment.spec.strategy, v.updateStrategy)
  assert.deepEqual(deployment.spec.template.spec.topologySpreadConstraints, [{
    maxSkew: 1, minDomains: 2, topologyKey: "kubernetes.io/hostname",
    whenUnsatisfiable: "DoNotSchedule", nodeTaintsPolicy: "Honor",
    labelSelector: deployment.spec.selector,
  }])
  assert.equal(deployment.spec.template.spec.containers[0].image, "registry.k8s.io/metrics-server/metrics-server:v0.8.1")
  assert.equal(deployment.spec.template.spec.hostNetwork, undefined)
  // No certificate, APIService, RBAC, image, resources or scraping changes.
  deployment.spec.replicas = 1
  delete deployment.spec.strategy
  delete deployment.spec.template.spec.topologySpreadConstraints
  assert.deepEqual(resources.filter(o => o.kind !== "PodDisruptionBudget"), original)
  const hub = render(values("hub-a"))
  assert.equal(hub.some(o => o.kind === "PodDisruptionBudget"), false)
  const hubDeployment = hub.find(o => o.kind === "Deployment")
  assert.equal(hubDeployment.spec.replicas, 1)
  assert.equal(hubDeployment.spec.template.spec.topologySpreadConstraints, undefined)
})

test("only Indigo's Metrics Server project permits the namespaced budget", () => {
  for (const cluster of ["indigo", "hub-a"]) {
    const project = kustomize(`gitops/components/argocd/overlays/${cluster}`)
      .find(o => o.kind === "AppProject" && o.metadata.name === "platform-metrics-server")
    assert.deepEqual(project.spec.namespaceResourceWhitelist.filter((p: any) => p.group === "policy"),
      cluster === "indigo" ? [{ group: "policy", kind: "PodDisruptionBudget" }] : [])
    assert.deepEqual(project.spec.destinations, [{ server: "https://kubernetes.default.svc", namespace: "kube-system" }])
  }
})

test("Metrics Server remains in the shared ApplicationSet with pinned chart and manual sync", () => {
  const applicationSet = kustomize("gitops/clusters/indigo/applications").find(o => o.kind === "ApplicationSet")
  const app = (previewApplicationSet(applicationSet) as any[]).find(o => o.metadata.name === "metrics-server")
  assert.equal(app.spec.project, "platform-metrics-server")
  assert.equal(app.spec.sources[0].targetRevision, "3.13.1")
  assert.deepEqual(app.spec.sources[0].helm.valueFiles, [`$values/${common}`, `$values/${overlay("indigo")}`])
  assert.equal(app.spec.syncPolicy.automated.enabled, false)
  assert.equal(app.spec.syncPolicy.automated.prune, false)
})
