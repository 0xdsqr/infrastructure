// Kubernetes owns Node objects. Manage only these two keys, never whole Nodes
// through Argo (which would introduce node deletion/pruning ownership).
export const poolLabel = "platform.dsqr.dev/node-pool"
export const dedicatedKey = "platform.dsqr.dev/dedicated"
export const platformTaint = { key: dedicatedKey, value: "platform", effect: "NoSchedule" } as const
export const indigoWorkers = [
  { name: "srv-lx-k8s-indigo-worker-01", address: "10.10.80.103", pool: "platform" },
  { name: "srv-lx-k8s-indigo-worker-02", address: "10.10.80.104", pool: "platform" },
  { name: "srv-lx-k8s-indigo-worker-03", address: "10.10.80.105", pool: "platform" },
  { name: "srv-lx-k8s-indigo-worker-04", address: "10.10.80.106", pool: "applications" },
  { name: "srv-lx-k8s-indigo-worker-05", address: "10.10.80.107", pool: "applications" },
  { name: "srv-lx-k8s-indigo-worker-06", address: "10.10.80.108", pool: "applications" },
] as const

type Metadata = { name: string; namespace?: string; resourceVersion?: string; generation?: number; labels?: Record<string, string> }
type Taint = { key: string; value?: string; effect: string }
type Toleration = { key?: string; value?: string; effect?: string; operator?: string }
export type Node = {
  metadata: Metadata
  spec: { taints?: Taint[]; unschedulable?: boolean }
  status: { addresses?: { type: string; address: string }[]; conditions?: { type: string; status: string }[] }
}
type PodSpec = { nodeName?: string; nodeSelector?: Record<string, string>; tolerations?: Toleration[] }
export type Pod = { metadata: Metadata; spec: PodSpec; status: { phase: string; conditions?: { type: string; status: string }[] } }
export type Workload = {
  kind: string
  metadata: Metadata
  spec: { replicas?: number; template: { spec: PodSpec } }
  status?: { observedGeneration?: number; readyReplicas?: number; updatedReplicas?: number; currentRevision?: string; updateRevision?: string; desiredNumberScheduled?: number; numberReady?: number; updatedNumberScheduled?: number }
}

export const platformWorkloads = [
  "argocd/argocd-server", "argocd/argocd-repo-server", "argocd/argocd-applicationset-controller",
  "argocd/argocd-application-controller", "argocd/argocd-redis-ha-server", "argocd/argocd-redis-ha-haproxy", "argocd/reloader",
  "external-secrets/external-secrets", "external-secrets/external-secrets-cert-controller", "external-secrets/external-secrets-webhook",
  "envoy-gateway-system/envoy-gateway", "envoy-gateway-system/@shared-envoy",
  "kube-system/cilium-operator", "kube-system/coredns", "kube-system/kubelet-csr-approver", "kube-system/metrics-server",
  "metallb-system/metallb-controller",
] as const

export const toleratesPlatform = (pod: PodSpec) => (pod.tolerations ?? []).some(t =>
  (!t.effect || t.effect === platformTaint.effect) &&
  (t.operator === "Exists" ? !t.key || t.key === dedicatedKey : t.key === dedicatedKey && t.value === "platform"),
)

export function validateWorkers(nodes: Node[], requireLabels = false, registrationOnly = false): void {
  for (const target of indigoWorkers) {
    const node = nodes.find(n => n.metadata.name === target.name)
    // Cilium's operator may itself need these labels to make new nodes Ready.
    // Labels may be applied incrementally; reservation requires the full pool.
    if (!node && registrationOnly) continue
    if (!node || !node.status.addresses?.some(a => a.type === "InternalIP" && a.address === target.address)) {
      throw new Error(`Missing node or unexpected InternalIP: ${target.name}`)
    }
    if ("node-role.kubernetes.io/control-plane" in (node.metadata.labels ?? {})) throw new Error(`Refusing control-plane node: ${target.name}`)
    if (!registrationOnly && (node.spec.unschedulable || !node.status.conditions?.some(c => c.type === "Ready" && c.status === "True"))) {
      throw new Error(`Node is not Ready and schedulable: ${target.name}`)
    }
    const current = node.metadata.labels?.[poolLabel]
    if ((current && current !== target.pool) || (requireLabels && current !== target.pool)) {
      throw new Error(`Unexpected pool on ${target.name}; expected ${target.pool}, found ${current ?? "unlabelled"}`)
    }
    for (const taint of node.spec.taints ?? []) {
      if (taint.key === dedicatedKey && (target.pool !== "platform" || taint.value !== "platform" || taint.effect !== "NoSchedule")) {
        throw new Error(`Conflicting dedicated taint on ${target.name}`)
      }
    }
  }
  const expected = new Set<string>(indigoWorkers.map(w => w.name))
  for (const node of nodes) {
    if (node.metadata.labels?.[poolLabel] === "platform" && !expected.has(node.metadata.name)) {
      throw new Error(`Unexpected platform pool member: ${node.metadata.name}`)
    }
  }
}

export function assertReservationSafe(nodes: Node[], workloads: Workload[], pods: Pod[]): void {
  validateWorkers(nodes, true)
  const id = (w: Workload) => `${w.metadata.namespace}/${w.metadata.name}`
  for (const name of platformWorkloads) {
    const matches = workloads.filter(w => name === "envoy-gateway-system/@shared-envoy"
      ? w.kind === "Deployment" && w.metadata.namespace === "envoy-gateway-system" &&
        w.metadata.labels?.["gateway.envoyproxy.io/owning-gateway-name"] === "shared" &&
        w.metadata.labels?.["gateway.envoyproxy.io/owning-gateway-namespace"] === "gateway-system"
      : id(w) === name)
    const w = matches.length === 1 ? matches[0] : undefined
    if (!w || w.spec.template.spec.nodeSelector?.[poolLabel] !== "platform" || !toleratesPlatform(w.spec.template.spec)) {
      throw new Error(`Deploy platform placement and toleration first: ${name}`)
    }
    const replicas = w.spec.replicas ?? 1
    if (replicas < 1 || w.status?.readyReplicas !== replicas || w.status?.updatedReplicas !== replicas ||
        (w.status?.observedGeneration ?? 0) < (w.metadata.generation ?? 1) ||
        (w.kind === "StatefulSet" && w.status?.currentRevision !== w.status?.updateRevision)) {
      throw new Error(`Rollout is not complete: ${name}`)
    }
  }
  for (const [name, count] of [["kube-system/cilium", 9], ["kube-system/cilium-envoy", 9], ["metallb-system/metallb-speaker", 6]] as const) {
    const w = workloads.find(w => id(w) === name && w.kind === "DaemonSet")
    if (!w || !toleratesPlatform(w.spec.template.spec) || w.spec.template.spec.nodeSelector?.[poolLabel] ||
        w.status?.desiredNumberScheduled !== count || w.status?.numberReady !== count || w.status?.updatedNumberScheduled !== count ||
        (w.status?.observedGeneration ?? 0) < (w.metadata.generation ?? 1)) {
      throw new Error(`Node-wide agent must tolerate the pool and remain fully rolled out: ${name}`)
    }
  }
  const platformNodes = new Set<string>(indigoWorkers.filter(w => w.pool === "platform").map(w => w.name))
  for (const pod of pods) {
    if (["Succeeded", "Failed"].includes(pod.status.phase)) continue
    if (pod.spec.nodeSelector?.[poolLabel] === "platform" && !platformNodes.has(pod.spec.nodeName ?? "")) {
      throw new Error(`Platform Pod is pending or on the wrong node: ${pod.metadata.namespace}/${pod.metadata.name}`)
    }
    if (!platformNodes.has(pod.spec.nodeName ?? "")) continue
    if (!toleratesPlatform(pod.spec) || !pod.status.conditions?.some(c => c.type === "Ready" && c.status === "True")) {
      throw new Error(`Platform-node Pod is not ready or lacks toleration: ${pod.metadata.namespace}/${pod.metadata.name}`)
    }
  }
}

// Optimistic concurrency prevents dropping a taint written by another operator.
export function labelPatch(node: Node, pool: string) {
  return [
    { op: "test", path: "/metadata/resourceVersion", value: node.metadata.resourceVersion },
    { op: "add", path: "/metadata/labels", value: { ...node.metadata.labels, [poolLabel]: pool } },
  ]
}
export function reservationPatch(node: Node) {
  return [
    { op: "test", path: "/metadata/resourceVersion", value: node.metadata.resourceVersion },
    { op: "add", path: "/spec/taints", value: [...(node.spec.taints ?? []).filter(t => t.key !== dedicatedKey), platformTaint] },
  ]
}
