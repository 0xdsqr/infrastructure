import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import test from "node:test"
import { parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const decode = (s: string) => parseAllDocuments(s).map(d => d.toJSON()).filter(Boolean)
const render = (p: string) => decode(execFileSync("kubectl", ["kustomize", p], { encoding: "utf8" }))
const path = "gitops/components/cilium/overlays/indigo"
const access = render(path)
const config = readFileSync("gitops/components/telemetry-metrics/overlays/indigo/config.alloy", "utf8")
const block = (type: string, name: string) => config.split(`${type} "${name}" {`)[1].split("\n}\n")[0]

test("Cilium companion discovery stays namespace scoped under its manual Application", () => {
  const apps = render("gitops/clusters/indigo/applications").flatMap(r => previewApplicationSet(r))
  const app = apps.find(a => a.metadata.name === "cilium")
  assert.equal(app.spec.sources.length, 2)
  assert.equal(app.spec.sources[0].targetRevision, "1.20.1")
  assert.equal(app.spec.sources[1].path, path)
  assert.equal(app.spec.sources[1].ref, "values")
  assert.equal(app.spec.syncPolicy.automated.enabled, false)
  assert.equal(app.spec.syncPolicy.automated.prune, false)
  assert.ok(app.spec.syncPolicy.syncOptions.includes("FailOnSharedResource=true"))
  assert.equal(access.length, 2)
  for (const r of access) assert.equal(r.metadata.namespace, "kube-system")
  const role = access.find(r => r.kind === "Role")
  assert.deepEqual(role.rules, [{ apiGroups: [""], resources: ["pods"], verbs: ["list", "watch"] }])
  const binding = access.find(r => r.kind === "RoleBinding")
  assert.deepEqual(binding.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name })
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "indigo-metrics", namespace: "observability" }])
  const project = render("gitops/components/argocd/overlays/indigo")
    .find(r => r.kind === "AppProject" && r.metadata.name === "platform-cilium")
  for (const r of access) assert.ok(project.spec.namespaceResourceWhitelist.some((p: any) =>
    p.kind === r.kind && p.group === r.apiVersion.split("/")[0]))
})

test("agent and Envoy targets reuse exactly nine nodes with stable identities", () => {
  const inventory = block("discovery.relabel", "kubelets")
  const targets = [...inventory.matchAll(/__address__ = "([^"]+)", node = "([^"]+)"/g)]
  assert.equal(targets.length, 9)
  assert.equal(new Set(targets.map(t => t[1])).size, 9)
  for (const [name, port] of [["agent", "9962"], ["envoy", "9964"]]) {
    const relabel = block("discovery.relabel", `cilium_${name}`)
    assert.ok(relabel.includes("targets = discovery.relabel.kubelets.output"))
    assert.match(relabel, /source_labels = \["__address__"\]/)
    assert.ok(relabel.includes('regex = "(.+):10250"'))
    assert.ok(relabel.includes(`replacement = "$1:${port}"`))
    assert.equal((relabel.match(/rule \{/g) ?? []).length, 1)
    for (const [, address] of targets) assert.match(address.replace(/^(.+):10250$/, `$1:${port}`), new RegExp(`^10[.]10[.]80[.]10[0-8]:${port}$`))
  }
})

test("operator discovery includes only Running non-init metrics containers on platform workers", () => {
  const discovery = block("discovery.kubernetes", "cilium_operator")
  assert.ok(discovery.includes('namespaces { names = ["kube-system"] }'))
  assert.ok(discovery.includes("app.kubernetes.io/name=cilium-operator,app.kubernetes.io/part-of=cilium,io.cilium/app=operator,name=cilium-operator"))
  const relabel = block("discovery.relabel", "cilium_operator")
  const rules = [...relabel.matchAll(/rule \{([^}]+)\}/g)].map(([, r]) => r)
  const regexFor = (key: string) => new RegExp(`^(?:${JSON.parse(rules.find(r => r.includes(key) && r.includes('action = "keep"'))!.match(/regex = ("[^"]+")/)![1])})$`)
  const ports = regexFor("container_port_number")
  assert.ok(ports.test("cilium-operator;prometheus;9963"))
  for (const tuple of ["cilium-operator;health;9234", "sidecar;prometheus;9963", "cilium-agent;prometheus;9962"])
    assert.equal(ports.test(tuple), false)
  const nodes = regexFor("pod_node_name")
  for (let n = 1; n <= 3; n++) assert.ok(nodes.test(`srv-lx-k8s-indigo-worker-0${n}`))
  for (const node of ["srv-lx-k8s-indigo-control-01", "srv-lx-k8s-indigo-worker-04", "other-worker-01"])
    assert.equal(nodes.test(node), false)
  assert.match(relabel, /regex = "Running"/)
  assert.match(relabel, /container_init"\]\s+regex = "false"/)
  assert.doesNotMatch(relabel, /pod_ready|labelmap/)
  for (const label of ["namespace", "pod", "node", "instance"]) assert.ok(relabel.includes(`target_label = "${label}"`))
})

test("private HTTP metrics never receive credentials and remain bounded, clustered, and port scoped", () => {
  for (const component of ["agent", "operator", "envoy"]) {
    const scrape = block("prometheus.scrape", `cilium_${component}`)
    for (const line of [`targets = discovery.relabel.cilium_${component}.output`, `job_name = "cilium-${component}"`,
      'scheme = "http"', 'metrics_path = "/metrics"', 'scrape_interval = "30s"', 'scrape_timeout = "10s"',
      'sample_limit = 10000', 'follow_redirects = false', 'clustering { enabled = true }',
      'forward_to = [prometheus.remote_write.beacon.receiver]']) assert.ok(scrape.includes(line), line)
    assert.doesNotMatch(scrape, /bearer_token|authorization|tls_config|cert_file|key_file|honor_labels/)
  }
  const policy = render("gitops/components/telemetry-metrics/overlays/indigo")
    .find(r => r.kind === "CiliumNetworkPolicy").spec
  assert.deepEqual(policy.endpointSelector.matchLabels, { "app.kubernetes.io/instance": "indigo-metrics" })
  assert.deepEqual(policy.egress.find((r: any) => r.toPorts[0].ports.some((p: any) => p.port === "9962")), {
    toEntities: ["host", "remote-node", "kube-apiserver"],
    toPorts: [{ ports: ["9962", "9963", "9964"].map(port => ({ port, protocol: "TCP" })) }],
  })
})

test("pinned chart changes only agent metrics plus agent/operator rollout, never Envoy or datapath settings", {
  skip: !process.env.CILIUM_TEST_CHART,
}, () => {
  const args = ["template", "cilium", process.env.CILIUM_TEST_CHART!, "--namespace", "kube-system", "--kube-version", "1.36.3",
    "-f", "gitops/components/cilium/base/values-common.yaml", "-f", `${path}/values-overrides.yaml`]
  const after = decode(execFileSync("helm", args, { encoding: "utf8" }))
  // Disabling agent metrics reproduces the previous render. Explicit operator
  // and Envoy settings match the pinned chart defaults and must not roll Envoy.
  const before = decode(execFileSync("helm", [...args, "--set", "prometheus.enabled=false"], { encoding: "utf8" }))
  assert.equal(after.length, before.length)
  const identity = (r: any) => `${r.kind}/${r.metadata.name}`
  assert.deepEqual(after.filter((r, i) => !isDeepStrictEqual(r, before[i])).map(identity).sort(),
    ["ConfigMap/cilium-config", "DaemonSet/cilium", "Deployment/cilium-operator"])
  const cm = (docs: any[]) => docs.find(r => identity(r) === "ConfigMap/cilium-config").data
  const data = { ...cm(after) }
  assert.equal(data["prometheus-serve-addr"], ":9962")
  delete data["prometheus-serve-addr"]
  delete data["controller-group-metrics"]
  assert.deepEqual(data, cm(before))
  const agent = after.find(r => identity(r) === "DaemonSet/cilium")
  assert.equal(agent.spec.updateStrategy.rollingUpdate.maxUnavailable, 1)
  assert.equal(agent.spec.template.spec.hostNetwork, true)
  assert.ok(agent.spec.template.spec.containers[0].ports.some((p: any) => p.containerPort === 9962))
  const operator = after.find(r => identity(r) === "Deployment/cilium-operator")
  assert.equal(operator.spec.replicas, 2)
  assert.deepEqual(operator.spec.strategy.rollingUpdate, { maxSurge: 1, maxUnavailable: 0 })
  const labels = operator.spec.template.metadata.labels
  for (const [key, value] of Object.entries({ "app.kubernetes.io/name": "cilium-operator", "app.kubernetes.io/part-of": "cilium",
    "io.cilium/app": "operator", name: "cilium-operator" })) assert.equal(labels[key], value)
  assert.equal(after.some(r => r.kind === "ServiceMonitor"), false)
  assert.equal(after.some(r => r.kind === "Service" && /metrics/.test(r.metadata.name)), false)
})
