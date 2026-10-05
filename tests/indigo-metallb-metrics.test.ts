import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const decode = (s: string) => parseAllDocuments(s).map(d => d.toJSON()).filter(Boolean)
const render = (p: string) => decode(execFileSync("kubectl", ["kustomize", p], { encoding: "utf8" }))
const path = "gitops/components/metallb/controller-access/overlays/indigo"
const access = render(path)
const pipeline = render("gitops/components/telemetry-metrics/overlays/indigo")
const config = readFileSync("gitops/components/telemetry-metrics/overlays/indigo/config.alloy", "utf8")
const collector = { "app.kubernetes.io/name": "alloy", "app.kubernetes.io/instance": "indigo-metrics" }
const identity = (r: any) => `${r.apiVersion}/${r.kind}/${r.metadata.namespace}/${r.metadata.name}`

test("MetalLB companions preserve ownership without absorbing load-balancer configuration", () => {
  const apps = render("gitops/clusters/indigo/applications").flatMap(r => previewApplicationSet(r))
  const app = apps.find(a => a.metadata.name === "metallb")
  assert.equal(app.spec.sources.length, 2)
  assert.equal(app.spec.sources[0].targetRevision, "0.16.1")
  assert.equal(app.spec.sources[1].path, path)
  assert.equal(app.spec.sources[1].ref, "values")
  assert.equal(app.spec.syncPolicy.automated.enabled, false)
  assert.equal(app.spec.syncPolicy.automated.prune, false)
  assert.ok(app.spec.syncPolicy.syncOptions.includes("FailOnSharedResource=true"))
  const cfg = apps.find(a => a.metadata.name === "metallb-config")
  assert.equal(cfg.spec.source.path, "gitops/components/metallb/overlays/indigo")
  const configuration = render(cfg.spec.source.path)
  assert.deepEqual(configuration.map(r => r.kind).sort(), ["IPAddressPool", "IPAddressPool", "L2Advertisement"])
  assert.equal(access.length, 4)
  for (const r of access) {
    assert.equal(r.metadata.namespace, "metallb-system")
    assert.equal(configuration.some(c => identity(c) === identity(r)), false)
  }
  assert.equal(apps.find(a => a.metadata.name === "indigo-metrics").spec.syncPolicy.automated.enabled, false)
})

test("discovery adds pod metadata only and reuses the collector's existing metrics grant", () => {
  const role = access.find(r => r.kind === "Role")
  assert.deepEqual(role.rules, [{ apiGroups: [""], resources: ["pods"], verbs: ["list", "watch"] }])
  const binding = access.find(r => r.kind === "RoleBinding")
  assert.deepEqual(binding.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name })
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "indigo-metrics", namespace: "observability" }])
  assert.deepEqual(pipeline.find(r => r.kind === "ClusterRole").rules[1], { nonResourceURLs: ["/metrics"], verbs: ["get"] })
  const project = render("gitops/components/argocd/overlays/indigo")
    .find(r => r.kind === "AppProject" && r.metadata.name === "platform-metallb")
  for (const r of access) assert.ok(project.spec.namespaceResourceWhitelist.some((p: any) =>
    p.kind === r.kind && p.group === r.apiVersion.split("/")[0]))
})

test("controller metrics are collector-only while admission and API access remain unchanged", () => {
  const deny = access.find(r => r.metadata.name === "default-deny")
  assert.deepEqual(deny.spec, { podSelector: {}, policyTypes: ["Ingress", "Egress"] })
  const p = access.find(r => r.metadata.name === "controller").spec
  assert.deepEqual(p.podSelector.matchLabels, {
    "app.kubernetes.io/name": "metallb", "app.kubernetes.io/instance": "metallb", "app.kubernetes.io/component": "controller",
  })
  assert.deepEqual(p.egress, [{ ports: [{ protocol: "TCP", port: 6443 }] }])
  assert.deepEqual(p.ingress, [
    { ports: [{ protocol: "TCP", port: "webhook-server" }] },
    { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "observability" } },
      podSelector: { matchLabels: collector } }], ports: [{ protocol: "TCP", port: "metricshttps" }] },
  ])
  const egress = pipeline.find(r => r.kind === "NetworkPolicy").spec.egress
    .find((r: any) => r.to.some((t: any) => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "metallb-system"))
  assert.deepEqual(egress, { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "metallb-system" } },
    podSelector: p.podSelector }], ports: [{ protocol: "TCP", port: 9120 }] })
  const host = pipeline.find(r => r.kind === "CiliumNetworkPolicy").spec.egress
  assert.deepEqual(host.at(-1), { toEntities: ["host", "remote-node"], toPorts: [{ ports: [{ port: "9120", protocol: "TCP" }] }] })
})

test("discovery keeps only real metrics containers, including unready Running pods", () => {
  const discovery = config.split('discovery.kubernetes "metallb" {')[1].split("discovery.relabel")[0]
  assert.ok(discovery.includes('namespaces { names = ["metallb-system"] }'))
  assert.ok(discovery.includes("app.kubernetes.io/name=metallb,app.kubernetes.io/instance=metallb,app.kubernetes.io/component in (controller,speaker)"))
  for (const component of ["controller", "speaker"]) {
    const relabel = config.split(`discovery.relabel "metallb_${component}" {`)[1].split("prometheus.scrape")[0]
    const rules = [...relabel.matchAll(/rule \{([^}]+)\}/g)].map(([, rule]) => rule)
    const filter = rules.find(r => r.includes("container_port_number"))!
    const regex = new RegExp(`^(?:${JSON.parse(filter.match(/regex = ("[^"]+")/)![1])})$`)
    assert.ok(regex.test(`${component};${component};metricshttps;9120`))
    for (const tuple of ["speaker;speaker;memberlist;7946", "controller;controller;webhook-server;9443",
      `${component};sidecar;metricshttps;9120`, `${component};${component};metrics;7472`, "unrelated;unrelated;metricshttps;9120"])
      assert.equal(regex.test(tuple), false, tuple)
    assert.match(relabel, /regex = "Running"/)
    assert.match(relabel, /container_init"\]\s+regex = "false"/)
    assert.doesNotMatch(relabel, /pod_ready|labelmap/)
    for (const label of ["namespace", "pod", "node", "instance"]) assert.ok(relabel.includes(`target_label = "${label}"`))
    if (component === "speaker") {
      const filter = rules.find(r => r.includes('action = "keep"') && r.includes("pod_node_name"))!
      const nodes = new RegExp(`^(?:${JSON.parse(filter.match(/regex = ("[^"]+")/)![1])})$`)
      for (let n = 1; n <= 6; n++) assert.ok(nodes.test(`srv-lx-k8s-indigo-worker-0${n}`))
      for (const node of ["srv-lx-k8s-indigo-worker-07", "srv-lx-k8s-indigo-control-01", "other-worker-01"]) assert.equal(nodes.test(node), false)
    }
  }
})

test("MetalLB scrapes authenticate only after verified TLS, with bounded clustered collection", () => {
  for (const component of ["controller", "speaker"]) {
    const scrape = config.split(`prometheus.scrape "metallb_${component}" {`)[1].split("\n}\n")[0]
    for (const line of [
      `targets = discovery.relabel.metallb_${component}.output`, `job_name = "metallb-${component}"`,
      'scheme = "https"', 'metrics_path = "/metrics"', 'scrape_interval = "30s"', 'scrape_timeout = "10s"',
      'sample_limit = 10000', 'follow_redirects = false',
      'bearer_token_file = "/var/run/secrets/kubernetes.io/serviceaccount/token"',
      'ca_file = "/etc/telemetry/ca/ca.crt"', `server_name = "metallb-${component}-metrics.metallb-system.svc"`,
      'insecure_skip_verify = false', 'min_version = "TLS12"', 'clustering { enabled = true }',
      'forward_to = [prometheus.remote_write.beacon.receiver]',
    ]) assert.ok(scrape.includes(line), line)
    assert.doesNotMatch(scrape, /cert_file|key_file|bearer_token\s*=/)
  }
})

test("pinned MetalLB render replaces the two policies under the same owner without rolling pods", {
  skip: !process.env.METALLB_TEST_CHART,
}, () => {
  const args = ["template", "metallb", process.env.METALLB_TEST_CHART!, "--namespace", "metallb-system",
    "-f", "gitops/components/metallb/base/values-common.yaml",
    "-f", "gitops/components/metallb/overlays/indigo/values-overrides.yaml"]
  const before = decode(execFileSync("helm", [...args, "--set", "networkpolicies.enabled=true,networkpolicies.defaultDeny=true,networkpolicies.apiPort=6443"], { encoding: "utf8" }))
  const after = decode(execFileSync("helm", args, { encoding: "utf8" }))
  assert.deepEqual(after, before.filter(r => r.kind !== "NetworkPolicy"))
  const previousPolicies = before.filter(r => r.kind === "NetworkPolicy")
  const policies = access.filter(r => r.kind === "NetworkPolicy")
  assert.deepEqual(policies.map(identity).sort(), previousPolicies.map(identity).sort())
  assert.equal(new Set([...after, ...access].map(identity)).size, after.length + access.length)
  // Only metrics source restriction changes; no namespace default-deny gap,
  // workload rollout, webhook connectivity change, or broader API egress.
  for (const previous of previousPolicies) {
    const current = structuredClone(policies.find(r => identity(r) === identity(previous)))
    if (previous.metadata.name === "controller") current.spec.ingress = previous.spec.ingress
    assert.deepEqual(current.spec, previous.spec)
  }
})
