import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parseAllDocuments } from "yaml"
import { assertReservationSafe, dedicatedKey, indigoWorkers, labelPatch, platformTaint, platformWorkloads, poolLabel, reservationPatch, toleratesPlatform, validateWorkers, type Node, type Workload } from "../packages/cluster/src/node-pools.ts"

const nodes = (): Node[] => indigoWorkers.map(w => ({
  metadata: { name: w.name, resourceVersion: "7", labels: { [poolLabel]: w.pool, existing: "keep" } }, spec: {},
  status: { addresses: [{ type: "InternalIP", address: w.address }], conditions: [{ type: "Ready", status: "True" }] },
}))
const workloads = (): Workload[] => [
  ...platformWorkloads.map(id => {
    const [namespace, name] = id.split("/")
    return { kind: "Deployment", metadata: { namespace, name: name!, generation: 1,
      labels: name === "@shared-envoy" ? { "gateway.envoyproxy.io/owning-gateway-name": "shared", "gateway.envoyproxy.io/owning-gateway-namespace": "gateway-system" } : {} },
      spec: { replicas: 2, template: { spec: { nodeSelector: { [poolLabel]: "platform" }, tolerations: [platformTaint] } } },
      status: { observedGeneration: 1, readyReplicas: 2, updatedReplicas: 2 } }
  }),
  ...[["kube-system", "cilium", 9], ["kube-system", "cilium-envoy", 9], ["metallb-system", "metallb-speaker", 6]].map(([namespace, name, count]) => ({
    kind: "DaemonSet", metadata: { namespace: String(namespace), name: String(name), generation: 1 },
    spec: { template: { spec: { tolerations: [platformTaint] } } },
    status: { observedGeneration: 1, desiredNumberScheduled: Number(count), numberReady: Number(count), updatedNumberScheduled: Number(count) },
  })),
]

test("pool inventory is three platform and three applications, never control planes", () => {
  assert.deepEqual(indigoWorkers.map(w => w.pool), ["platform", "platform", "platform", "applications", "applications", "applications"])
  validateWorkers(nodes(), true)
  for (const mutate of [
    (n: Node[]) => { n[0]!.status.addresses = [] },
    (n: Node[]) => { n[0]!.spec.unschedulable = true },
    (n: Node[]) => { n[0]!.status.conditions = [] },
    (n: Node[]) => { n[0]!.metadata.labels![poolLabel] = "applications" },
    (n: Node[]) => { n[0]!.metadata.labels!["node-role.kubernetes.io/control-plane"] = "" },
    (n: Node[]) => { n[3]!.spec.taints = [platformTaint] },
    (n: Node[]) => { n[0]!.spec.taints = [{ ...platformTaint, effect: "NoExecute" }] },
  ]) {
    const copy = nodes(); mutate(copy); assert.throws(() => validateWorkers(copy, true))
  }
})

test("bootstrap labels allow registered NotReady nodes without weakening reservation checks", () => {
  const partial = nodes().slice(0, 1)
  partial[0]!.status.conditions = []
  delete partial[0]!.metadata.labels![poolLabel]
  validateWorkers(partial, false, true)
  assert.throws(() => validateWorkers(partial, true))
  partial[0]!.status.addresses = []
  assert.throws(() => validateWorkers(partial, false, true), /unexpected InternalIP/)
})

test("node patches are race guarded, idempotent and preserve unrelated labels and taints", () => {
  const n = nodes()[0]!
  n.spec.taints = [{ key: "maintenance", value: "keep", effect: "PreferNoSchedule" }, platformTaint]
  const patch = reservationPatch(n)
  assert.deepEqual(patch[0], { op: "test", path: "/metadata/resourceVersion", value: "7" })
  assert.deepEqual(patch[1]!.value, n.spec.taints)
  assert.deepEqual(labelPatch(n, "platform")[1]!.value, n.metadata.labels)
  assert.equal(platformTaint.effect, "NoSchedule")
})

test("reservation requires every platform template and healthy node-wide agents", () => {
  assertReservationSafe(nodes(), workloads(), [])
  for (const name of platformWorkloads) {
    const ws = workloads().filter(w => `${w.metadata.namespace}/${w.metadata.name}` !== name)
    assert.throws(() => assertReservationSafe(nodes(), ws, []), /Deploy platform/)
  }
  for (const mutate of [
    (ws: Workload[]) => { ws[0]!.spec.template.spec.tolerations = [] },
    (ws: Workload[]) => { ws[0]!.status!.updatedReplicas = 1 },
    (ws: Workload[]) => { ws[0]!.status!.observedGeneration = 0 },
    (ws: Workload[]) => { ws.at(-1)!.spec.template.spec.tolerations = [] },
    (ws: Workload[]) => { ws.at(-1)!.spec.template.spec.nodeSelector = { [poolLabel]: "platform" } },
    (ws: Workload[]) => { ws.at(-1)!.status!.numberReady = 5 },
  ]) {
    const ws = workloads(); mutate(ws); assert.throws(() => assertReservationSafe(nodes(), ws, []))
  }
  assert.throws(() => assertReservationSafe(nodes(), workloads(), [{
    metadata: { name: "old-pod", namespace: "argocd" }, spec: { nodeName: indigoWorkers[0].name },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }]), /lacks toleration/)
  assert.throws(() => assertReservationSafe(nodes(), workloads(), [{
    metadata: { name: "pending", namespace: "argocd" }, spec: { nodeSelector: { [poolLabel]: "platform" } },
    status: { phase: "Pending" },
  }]), /pending or on the wrong node/)
})

const cases = [
  ["argocd", "ARGOCD_TEST_CHART", "argocd"],
  ["cilium", "CILIUM_TEST_CHART", "kube-system"],
  ["metallb", "METALLB_TEST_CHART", "metallb-system"],
  ["external-secrets", "EXTERNAL_SECRETS_TEST_CHART", "external-secrets"],
  ["reloader", "RELOADER_TEST_CHART", "argocd"],
  ["envoy-gateway", "ENVOY_GATEWAY_TEST_CHART", "envoy-gateway-system"],
  ["metrics-server", "METRICS_SERVER_TEST_CHART", "kube-system"],
  ["kubelet-csr-approver", "CSR_APPROVER_TEST_CHART", "kube-system"],
] as const
for (const [component, variable, namespace] of cases) {
  const chart = process.env[variable]
  test(`pinned ${component} chart places every controller and hook job in the platform pool`, { skip: !chart }, () => {
    const objects = parseAllDocuments(execFileSync("helm", ["template", component, chart!, "--namespace", namespace,
      "--kube-version", "1.36.3", "--skip-tests", "-f", `gitops/components/${component}/base/values-common.yaml`,
      "-f", `gitops/components/${component}/overlays/indigo/values-overrides.yaml`,
    ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 })).map(d => d.toJSON()).filter(Boolean)
    const targets = objects.filter(o => ["Deployment", "StatefulSet", "Job", "DaemonSet"].includes(o.kind))
    assert.ok(targets.length > 0)
    for (const o of targets) {
      const pod = o.spec.template.spec
      assert.ok(toleratesPlatform(pod), o.metadata.name)
      assert.equal(pod.nodeSelector?.[poolLabel], o.kind === "DaemonSet" ? undefined : "platform", o.metadata.name)
    }
    if (component === "argocd") {
      const redis = targets.find(o => o.metadata.name === "argocd-redis-ha-server")
      assert.equal(redis.spec.replicas, 3)
      assert.equal(redis.spec.template.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey, "kubernetes.io/hostname")
      assert.equal(objects.find(o => o.kind === "PodDisruptionBudget" && o.metadata.name === "argocd-redis-ha-pdb").spec.minAvailable, 2)
    }
  })
}

test("Envoy proxy placement and stronger spread are Indigo-only; L2 speakers retain all workers", () => {
  for (const cluster of ["indigo", "base"]) {
    const path = cluster === "base" ? "gitops/components/gateway/base" : `gitops/components/gateway/overlays/${cluster}`
    const objects = parseAllDocuments(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" })).map(d => d.toJSON()).filter(Boolean)
    const pod = objects.find(o => o.kind === "EnvoyProxy").spec.provider.kubernetes.envoyDeployment.pod
    assert.equal(pod.nodeSelector?.[poolLabel], cluster === "indigo" ? "platform" : undefined)
    if (cluster === "indigo") {
      assert.ok(toleratesPlatform(pod))
      assert.equal(pod.topologySpreadConstraints[0].minDomains, 2)
      assert.equal(pod.topologySpreadConstraints[0].nodeTaintsPolicy, "Honor")
    }
  }
  const l2 = readFileSync("gitops/components/metallb/overlays/indigo/l2advertisement.yaml", "utf8")
  assert.ok(l2.includes("node-role.kubernetes.io/control-plane"))
  assert.equal(l2.includes(poolLabel), false)
  assert.equal(dedicatedKey, "platform.dsqr.dev/dedicated")
})
