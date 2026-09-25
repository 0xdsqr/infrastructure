import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments, stringify } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const decode = (text: string) => parseAllDocuments(text, { version: "1.1" }).map(d => d.toJSON()).filter(Boolean)
const overlay = (component: string, cluster = "indigo") => `gitops/components/${component}/overlays/${cluster}/values-overrides.yaml`
const values = (component: string, cluster = "indigo") => parse(readFileSync(overlay(component, cluster), "utf8"))
const kustomize = (path: string) => decode(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" }))
const render = (component: string, chart: string, overrides: unknown) => decode(execFileSync("helm", [
  "template", component, chart, "--namespace", "kube-system", "--kube-version", "1.36.3",
  "-f", `gitops/components/${component}/base/values-common.yaml`, "-f", "-",
], { input: stringify(overrides), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }))

const ciliumChart = process.env.CILIUM_TEST_CHART
const csrChart = process.env.CSR_APPROVER_TEST_CHART

test("pinned Cilium chart changes only the operator rollout strategy and adds its budget", { skip: !ciliumChart }, () => {
  const configured = values("cilium")
  const before = structuredClone(configured)
  delete before.operator.updateStrategy
  delete before.operator.podDisruptionBudget
  const resources = render("cilium", ciliumChart!, configured)
  const original = render("cilium", ciliumChart!, before)
  const budgets = resources.filter(o => o.kind === "PodDisruptionBudget")
  assert.equal(budgets.length, 1)
  const deployment = resources.find(o => o.kind === "Deployment" && o.metadata.name === "cilium-operator")
  assert.equal(deployment.spec.replicas, 2)
  assert.equal(budgets[0].spec.minAvailable, 1)
  assert.equal(budgets[0].spec.maxUnavailable, undefined)
  assert.deepEqual(budgets[0].spec.selector, deployment.spec.selector)
  assert.deepEqual(deployment.spec.strategy, { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } })
  assert.equal(deployment.spec.template.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey, "kubernetes.io/hostname")
  deployment.spec.strategy = original.find(o => o.kind === "Deployment" && o.metadata.name === "cilium-operator").spec.strategy
  assert.deepEqual(resources.filter(o => o.kind !== "PodDisruptionBudget"), original,
    "Cilium agents, Envoy, Hubble TLS and all other resources must be unchanged")
  assert.equal(render("cilium", ciliumChart!, values("cilium", "hub-a")).some(o => o.kind === "PodDisruptionBudget"), false)
})

test("pinned CSR chart adds node separation and budget without changing certificate approval", { skip: !csrChart }, () => {
  const configured = values("kubelet-csr-approver")
  const before = structuredClone(configured)
  delete before.affinity
  delete before.extraObjects
  const resources = render("kubelet-csr-approver", csrChart!, configured)
  const original = render("kubelet-csr-approver", csrChart!, before)
  const deployment = resources.find(o => o.kind === "Deployment")
  const budgets = resources.filter(o => o.kind === "PodDisruptionBudget")
  assert.equal(budgets.length, 1)
  assert.equal(budgets[0].spec.minAvailable, 1)
  assert.equal(budgets[0].spec.maxUnavailable, undefined)
  assert.equal(budgets[0].metadata.namespace, "kube-system")
  assert.deepEqual(budgets[0].spec.selector, deployment.spec.selector)
  assert.equal(deployment.spec.replicas, 2)
  assert.ok(deployment.spec.template.spec.containers[0].args.includes("-leader-election"))
  assert.deepEqual(deployment.spec.template.spec.affinity, {
    podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{
      topologyKey: "kubernetes.io/hostname", labelSelector: deployment.spec.selector,
    }] },
  })
  // This chart does not expose strategy: Kubernetes defaults to RollingUpdate
  // with 25% surge/unavailable (one surge and zero unavailable at two replicas).
  assert.equal(deployment.spec.strategy, undefined)
  delete deployment.spec.template.spec.affinity
  assert.deepEqual(resources.filter(o => o.kind !== "PodDisruptionBudget"), original)
})

test("only Indigo opts into kube-system disruption budgets, without taking CoreDNS ownership", () => {
  for (const cluster of ["indigo", "hub-a"]) {
    const projects = kustomize(`gitops/components/argocd/overlays/${cluster}`)
    for (const name of ["platform-cilium", "platform-kubelet-csr-approver"]) {
      const project = projects.find(o => o.kind === "AppProject" && o.metadata.name === name)
      assert.deepEqual(project.spec.namespaceResourceWhitelist.filter((p: any) => p.group === "policy"),
        cluster === "indigo" ? [{ group: "policy", kind: "PodDisruptionBudget" }] : [])
    }
    const foundation = kustomize(`gitops/components/cluster-foundation/overlays/${cluster}`)
    assert.equal(foundation.some(o => o.kind === "Deployment"), false)
    const budgets = foundation.filter(o => o.kind === "PodDisruptionBudget")
    assert.equal(budgets.length, cluster === "indigo" ? 1 : 0)
    if (cluster === "indigo") {
      assert.equal(budgets[0].metadata.name, "coredns")
      assert.equal(budgets[0].metadata.namespace, "kube-system")
      assert.deepEqual(budgets[0].spec, { minAvailable: 1, selector: { matchLabels: { "k8s-app": "kube-dns" } } })
    }
  }
  const bootstrap = parse(readFileSync("gitops/clusters/indigo/bootstrap/bootstrap.appproject.yaml", "utf8"))
  assert.ok(bootstrap.spec.destinations.some((d: any) => d.namespace === "kube-system"))
  assert.ok(bootstrap.spec.namespaceResourceWhitelist.some((p: any) => p.group === "policy" && p.kind === "PodDisruptionBudget"))
  assert.equal(bootstrap.spec.namespaceResourceWhitelist.some((p: any) => p.kind === "Deployment"), false)
})

test("existing ApplicationSet controller applications retain pinned charts and manual sync", () => {
  const applicationSet = kustomize("gitops/clusters/indigo/applications").find(o => o.kind === "ApplicationSet")
  const apps = previewApplicationSet(applicationSet) as any[]
  for (const [name, version] of [["cilium", "1.20.1"], ["kubelet-csr-approver", "1.2.14"]]) {
    const app = apps.find(o => o.metadata.name === name)
    assert.equal(app.spec.sources[0].targetRevision, version)
    assert.deepEqual(app.spec.sources[0].helm.valueFiles, [
      `$values/gitops/components/${name}/base/values-common.yaml`, `$values/${overlay(name)}`,
    ])
    assert.equal(app.spec.syncPolicy.automated.enabled, false)
    assert.equal(app.spec.syncPolicy.automated.prune, false)
  }
})
