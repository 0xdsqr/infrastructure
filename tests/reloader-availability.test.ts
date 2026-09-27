import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const chart = process.env.RELOADER_TEST_CHART
const base = "gitops/components/reloader/base"
const overlay = "gitops/components/reloader/overlays/indigo"
const decode = (text: string) => parseAllDocuments(text, { version: "1.1" }).map(d => d.toJSON()).filter(Boolean)
const kustomize = (path: string) => decode(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" }))

test("Reloader HA retains namespace-local, opt-in renewal behavior", () => {
  const common = parse(readFileSync(`${base}/values-common.yaml`, "utf8")).reloader
  const values = parse(readFileSync(`${overlay}/values-overrides.yaml`, "utf8")).reloader
  assert.equal(values.enableHA, true)
  assert.equal(values.deployment.replicas, 2)
  assert.deepEqual(values.podDisruptionBudget, { enabled: true, minAvailable: 1 })
  assert.equal(common.deployment.replicas, 1)
  assert.equal(common.watchGlobally, false)
  assert.equal(common.autoReloadAll, false)
  assert.equal(common.rbac.enabled, false)
  assert.equal(common.resourceLabelSelector, "platform.dsqr.dev/tls-reload=true")
  assert.equal(common.syncAfterRestart, true)
  assert.equal(common.reloadOnCreate, true)
  assert.equal(common.reloadStrategy, "annotations")
  assert.equal(common.ignoreJobs, true)
  assert.equal(common.ignoreCronJobs, true)
})

test("Indigo adds only namespace-local lock permissions to Reloader's existing Role", () => {
  const before = kustomize(base).find(o => o.kind === "Role")
  const objects = kustomize(overlay)
  const role = objects.find(o => o.kind === "Role")
  assert.equal(role.metadata.namespace, "argocd")
  assert.deepEqual(role.rules.slice(0, before.rules.length), before.rules)
  assert.deepEqual(role.rules.slice(before.rules.length), [
    { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["create"] },
    { apiGroups: ["coordination.k8s.io"], resources: ["leases"], resourceNames: ["stakater-reloader-lock"], verbs: ["get", "update"] },
  ])
  assert.equal(objects.some(o => o.kind === "ClusterRole"), false)
  const project = kustomize("gitops/components/argocd/overlays/indigo")
    .find(o => o.kind === "AppProject" && o.metadata.name === "platform-reloader")
  assert.deepEqual(project.spec.clusterResourceWhitelist, [])
  assert.deepEqual(project.spec.destinations, [{ server: "https://kubernetes.default.svc", namespace: "argocd" }])
  assert.ok(project.spec.namespaceResourceWhitelist.some((r: any) => r.group === "policy" && r.kind === "PodDisruptionBudget"))
})

test("pinned Reloader chart renders elected replicas, matching spread and disruption budget", { skip: !chart }, () => {
  const objects = decode(execFileSync("helm", ["template", "reloader", chart!, "--namespace", "argocd",
    "--kube-version", "1.36.3", "-f", `${base}/values-common.yaml`, "-f", `${overlay}/values-overrides.yaml`,
  ], { encoding: "utf8" }))
  const deployment = objects.find(o => o.kind === "Deployment")
  const pod = deployment.spec.template.spec
  const container = pod.containers[0]
  assert.equal(deployment.spec.replicas, 2)
  assert.ok(container.args.includes("--enable-ha=true"))
  for (const name of ["POD_NAME", "POD_NAMESPACE"]) {
    assert.ok(container.env.find((e: any) => e.name === name)?.valueFrom.fieldRef)
  }
  assert.deepEqual(pod.topologySpreadConstraints, [{
    maxSkew: 1, minDomains: 2, topologyKey: "kubernetes.io/hostname",
    whenUnsatisfiable: "DoNotSchedule", nodeTaintsPolicy: "Honor", labelSelector: deployment.spec.selector,
  }])
  const pdb = objects.find(o => o.kind === "PodDisruptionBudget")
  assert.equal(pdb.spec.minAvailable, 1)
  assert.deepEqual(pdb.spec.selector, deployment.spec.selector)
  assert.equal(container.securityContext.allowPrivilegeEscalation, false)
  assert.equal(objects.some(o => o.kind === "ClusterRole" || o.kind === "Role"), false)
})

test("Reloader HA uses the existing generated, manually synced Application", () => {
  const set = kustomize("gitops/clusters/indigo/applications").find(o => o.kind === "ApplicationSet")
  const app = (previewApplicationSet(set) as any[]).find(o => o.metadata.name === "reloader")
  assert.equal(app.spec.project, "platform-reloader")
  assert.equal(app.spec.sources[0].targetRevision, "2.2.17")
  assert.equal(app.spec.syncPolicy.automated.enabled, false)
  assert.equal(app.spec.syncPolicy.automated.prune, false)
  assert.ok(app.spec.sources.some((s: any) => s.path === overlay))
})
