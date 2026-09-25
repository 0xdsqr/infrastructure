import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const chart = process.env.EXTERNAL_SECRETS_TEST_CHART
const common = "gitops/components/external-secrets/base/values-common.yaml"
const overlay = (cluster: string) => `gitops/components/external-secrets/overlays/${cluster}/values-overrides.yaml`
const decode = (text: string) => parseAllDocuments(text, { version: "1.1" }).map(d => d.toJSON()).filter(Boolean)
const kustomize = (path: string) => decode(execFileSync("kubectl", ["kustomize", path], {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
}))
const render = (cluster: string) => decode(execFileSync("helm", [
  "template", "external-secrets", chart!, "--namespace", "external-secrets", "--kube-version", "1.36.3",
  "--values", common, "--values", overlay(cluster),
], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }))

test("Indigo ESO preserves two replicas and leader election with bounded disruption and rollout", () => {
  const values = parse(readFileSync(overlay("indigo"), "utf8"))
  assert.equal(values.leaderElect, true)
  assert.deepEqual(values.global.topologySpreadConstraints, [{
    maxSkew: 1, minDomains: 2, topologyKey: "kubernetes.io/hostname",
    whenUnsatisfiable: "DoNotSchedule", nodeTaintsPolicy: "Honor",
  }])
  for (const component of [values, values.webhook, values.certController]) {
    assert.equal(component.replicaCount, 2)
    assert.deepEqual(component.podDisruptionBudget, { enabled: true, minAvailable: 1 })
    assert.deepEqual(component.strategy, {
      type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
    })
  }
  assert.equal(parse(readFileSync(common, "utf8")).replicaCount, 1)
})

test("pinned ESO chart gives each Indigo component its own spread selector and PDB", { skip: !chart }, () => {
  const resources = render("indigo")
  const deployments = resources.filter(o => o.kind === "Deployment")
  const budgets = resources.filter(o => o.kind === "PodDisruptionBudget")
  assert.equal(deployments.length, 3)
  assert.equal(budgets.length, 3)
  for (const deployment of deployments) {
    const pod = deployment.spec.template.spec
    const [spread] = pod.topologySpreadConstraints
    assert.equal(pod.topologySpreadConstraints.length, 1)
    assert.equal(spread.maxSkew, 1)
    assert.equal(spread.minDomains, 2)
    assert.equal(spread.topologyKey, "kubernetes.io/hostname")
    assert.equal(spread.whenUnsatisfiable, "DoNotSchedule")
    assert.equal(spread.nodeTaintsPolicy, "Honor")
    assert.deepEqual(spread.labelSelector, deployment.spec.selector)
    const matching = budgets.filter(b => JSON.stringify(b.spec.selector) === JSON.stringify(deployment.spec.selector))
    assert.equal(matching.length, 1)
    assert.equal(matching[0].spec.minAvailable, 1)
    assert.equal(matching[0].spec.maxUnavailable, undefined)
    assert.equal(matching[0].metadata.namespace, "external-secrets")
    assert.equal(deployment.spec.replicas, 2)
    assert.deepEqual(deployment.spec.strategy, {
      type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
    })
    if (deployment.metadata.name !== "external-secrets-webhook") {
      assert.ok(pod.containers[0].args.includes("--enable-leader-election=true"))
    }
  }
  const hub = render("hub-a")
  assert.equal(hub.some(o => o.kind === "PodDisruptionBudget"), false)
  for (const deployment of hub.filter(o => o.kind === "Deployment")) {
    assert.equal(deployment.spec.replicas, 1)
    assert.equal(deployment.spec.template.spec.topologySpreadConstraints, undefined)
  }
})

test("only Indigo's ESO project gains namespaced disruption-budget permission", () => {
  for (const cluster of ["indigo", "hub-a"]) {
    const project = kustomize(`gitops/components/argocd/overlays/${cluster}`)
      .find(o => o.kind === "AppProject" && o.metadata.name === "platform-external-secrets")
    assert.deepEqual(project.spec.namespaceResourceWhitelist.filter((r: any) => r.group === "policy"),
      cluster === "indigo" ? [{ group: "policy", kind: "PodDisruptionBudget" }] : [])
    assert.deepEqual(project.spec.destinations, [{ server: "https://kubernetes.default.svc", namespace: "external-secrets" }])
    assert.equal(project.spec.clusterResourceWhitelist.some((r: any) => r.group === "policy"), false)
  }
})

test("ESO availability remains wired through the existing manually synced ApplicationSet application", () => {
  const applicationSet = kustomize("gitops/clusters/indigo/applications").find(o => o.kind === "ApplicationSet")
  const application = (previewApplicationSet(applicationSet) as any[]).find(o => o.metadata.name === "external-secrets")
  assert.equal(application.spec.project, "platform-external-secrets")
  assert.equal(application.spec.sources[0].targetRevision, "2.8.0")
  assert.deepEqual(application.spec.sources[0].helm.valueFiles, [`$values/${common}`, `$values/${overlay("indigo")}`])
  assert.equal(application.spec.syncPolicy.automated.enabled, false)
  assert.equal(application.spec.syncPolicy.automated.prune, false)
})
