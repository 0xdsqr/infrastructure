import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { parseAllDocuments } from "yaml"

const config = readFileSync("gitops/components/telemetry-metrics/overlays/indigo/config.alloy", "utf8")
const decode = (text: string) => parseAllDocuments(text).map(d => d.toJSON()).filter(Boolean)
const resources = decode(execFileSync("kubectl", ["kustomize", "gitops/components/telemetry-metrics/overlays/indigo"], {encoding: "utf8"}))
const chart = process.env.ARGOCD_TEST_CHART
const targets = [
  ["argocd-application-controller", "metrics", "8082"],
  ["argocd-applicationset-controller", "metrics", "8080"],
  ["argocd-server", "metrics", "8083"],
  ["argocd-repo-server", "metrics", "8084"],
  ["argocd-redis-ha-haproxy", "metrics-port", "9101"],
  ["reloader", "http", "9090"],
]

test("pod discovery is limited to argocd and does not grant cluster-wide pod or Secret access", () => {
  const discovery = config.split('discovery.kubernetes "argocd" {')[1].split('discovery.relabel "argocd"')[0]
  assert.equal((config.match(/discovery.kubernetes "/g) ?? []).length, 1)
  assert.match(discovery, /role = "pod"/)
  assert.match(discovery, /namespaces \{ names = \["argocd"\] \}/)
  for (const [name] of targets) assert.ok(discovery.includes(name))
  const clusterRole = resources.find(r => r.kind === "ClusterRole")
  assert.deepEqual(clusterRole.rules.flatMap((r: any) => r.resources ?? []), ["nodes/metrics"])
})

test("only exact metric ports are discovered; every replica keeps its own identity", () => {
  const relabel = config.split('discovery.relabel "argocd" {')[1].split('prometheus.scrape "argocd"')[0]
  const portRule = [...relabel.matchAll(/rule \{([^}]+)\}/g)].find(([, r]) => r.includes("container_port_number"))![1]
  const regex = new RegExp(`^(?:${JSON.parse(portRule.match(/regex = ("[^"]+")/)![1])})$`)
  for (const target of targets) assert.ok(regex.test(target.join(";")))
  for (const target of ["argocd-server;server;8080", "argocd-repo-server;repo-server;8081",
    "argocd-applicationset-controller;webhook;7000", "argocd-redis-ha-haproxy;redis;6379",
    "reloader;http;8080", "unrelated;metrics;8082", "argocd-server;metrics;9999"]) {
    assert.equal(regex.test(target), false, target)
  }
  assert.match(relabel, /regex = "Running"/)
  assert.match(relabel, /source_labels = \["__meta_kubernetes_pod_container_init"\]\s+regex = "false"/)
  assert.doesNotMatch(relabel, /pod_ready|action = "labelmap"/)
  assert.match(relabel, /source_labels = \["__meta_kubernetes_pod_name"\]\s+target_label = "instance"/)
  const scrape = config.split('prometheus.scrape "argocd" {')[1].split('prometheus.exporter.self')[0]
  assert.match(scrape, /clustering \{ enabled = true \}/)
  assert.match(scrape, /sample_limit = 10000/)
  assert.match(scrape, /scrape_interval = "30s"/)
  assert.doesNotMatch(scrape, /bearer_token|authorization|honor_labels = true/)
})

test("collector egress permits only intended argocd metrics ports, not UI, RPC or Redis", () => {
  const rules = resources.find(r => r.kind === "NetworkPolicy").spec.egress
    .filter((r: any) => r.to.some((t: any) => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "argocd"))
  assert.equal(rules.length, 3)
  assert.deepEqual(rules.map((r: any) => r.ports), [
    [{protocol: "TCP", port: "metrics"}], [{protocol: "TCP", port: 9101}], [{protocol: "TCP", port: 9090}],
  ])
  for (const rule of rules) assert.ok(rule.to.every((t: any) => t.podSelector))
  assert.deepEqual(rules[0].to[0].podSelector.matchExpressions[0].values,
    targets.slice(0, 4).map(t => t[0]))
})

test("pinned Argo chart scopes discovery and ingress and preserves hub-a and all running workload specs", {skip: !chart}, () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-argocd-metrics-"))
  const basePath = "gitops/components/argocd/base/values-common.yaml"
  const overridePath = "gitops/components/argocd/overlays/indigo/values-overrides.yaml"
  // Fixed pre-monitoring revision keeps this test meaningful after committing.
  const baseline = "fe5aae0969a1825843522a0c635411177922ee0c"
  const render = (base: string, override: string) => decode(execFileSync("helm", ["template", "argocd", chart!,
    "--namespace", "argocd", "--kube-version", "1.36.3", "-f", base, "-f", override], {encoding: "utf8", maxBuffer: 16 * 1024 * 1024}))
  try {
    const oldBase = join(dir, "base.yaml")
    const oldOverride = join(dir, "indigo.yaml")
    writeFileSync(oldBase, execFileSync("git", ["show", `${baseline}:${basePath}`]))
    writeFileSync(oldOverride, execFileSync("git", ["show", `${baseline}:${overridePath}`]))
    const hub = "gitops/components/argocd/overlays/hub-a/values-overrides.yaml"
    assert.deepEqual(render(basePath, hub), render(oldBase, hub), "hub-a render must be identical")
    const current = render(basePath, overridePath)
    const previous = render(oldBase, oldOverride)
    const workloads = (objects: any[]) => objects.filter(r => ["Deployment", "StatefulSet", "Service", "Job", "ConfigMap", "Secret"].includes(r.kind))
    assert.deepEqual(workloads(current), workloads(previous), "no pod restart or service changes required")
    const role = current.find(r => r.kind === "Role" && r.metadata.name === "indigo-metrics-discovery")
    assert.equal(role.metadata.namespace, "argocd")
    assert.deepEqual(role.rules, [{apiGroups: [""], resources: ["pods"], verbs: ["list", "watch"]}])
    const binding = current.find(r => r.kind === "RoleBinding" && r.metadata.name === role.metadata.name)
    assert.deepEqual(binding.subjects, [{kind: "ServiceAccount", name: "indigo-metrics", namespace: "observability"}])
    assert.deepEqual(binding.roleRef, {apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name})
    const collector = {namespaceSelector: {matchLabels: {"kubernetes.io/metadata.name": "observability"}},
      podSelector: {matchLabels: {"app.kubernetes.io/instance": "indigo-metrics", "app.kubernetes.io/name": "alloy"}}}
    for (const [name, port] of [["argocd-allow-controller-metrics", 8082], ["argocd-allow-server-ingress", 8083],
      ["argocd-allow-repo-server-ingress", 8084], ["indigo-metrics-applicationset", 8080],
      ["indigo-metrics-haproxy", 9101], ["indigo-metrics-reloader", 9090]]) {
      const policy = current.find(r => r.kind === "NetworkPolicy" && r.metadata.name === name)
      const ingress = policy.spec.ingress.find((r: any) => r.ports.some((p: any) => p.port === port))
      assert.deepEqual(ingress.from, [collector], String(name))
    }
    const project = decode(execFileSync("kubectl", ["kustomize", "gitops/components/argocd/overlays/indigo"], {encoding: "utf8"}))
      .find(r => r.kind === "AppProject" && r.metadata.name === "platform-argocd")
    for (const kind of ["Role", "RoleBinding", "NetworkPolicy"]) {
      assert.ok(project.spec.namespaceResourceWhitelist.some((r: any) => r.kind === kind))
    }
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})
