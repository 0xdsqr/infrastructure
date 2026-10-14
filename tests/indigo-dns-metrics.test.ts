import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parseAllDocuments } from "yaml"

const path = "gitops/components/telemetry-metrics/overlays/indigo"
const config = readFileSync(`${path}/config.alloy`, "utf8")
const block = (type: string) => config.split(`${type} "coredns" {`)[1].split("\n}\n")[0]

test("CoreDNS discovery selects only running resolver metrics containers, retaining replica identity", () => {
  const discovery = block("discovery.kubernetes")
  assert.match(discovery, /namespaces \{ names = \["kube-system"\] \}/)
  assert.match(discovery, /label = "k8s-app=kube-dns"/)
  const relabel = block("discovery.relabel")
  assert.match(relabel, /regex = "Running"/)
  assert.match(relabel, /container_init"\]\s+regex = "false"/)
  const filter = [...relabel.matchAll(/rule \{([^}]+)\}/g)].map(([, r]) => r)
    .find(r => r.includes("container_port_number"))!
  const regex = new RegExp(`^(?:${JSON.parse(filter.match(/regex = ("[^"]+")/)![1])})$`)
  assert.ok(regex.test("kube-dns;coredns;metrics;9153"))
  for (const value of ["kube-dns;sidecar;metrics;9153", "kube-dns;coredns;dns;53",
    "other;coredns;metrics;9153", "kube-dns;coredns;metrics;8080"])
    assert.equal(regex.test(value), false)
  for (const label of ["namespace", "pod", "node", "instance"])
    assert.ok(relabel.includes(`target_label = "${label}"`))
  assert.doesNotMatch(relabel, /pod_ready|labelmap/)
})

test("CoreDNS scrape is bounded, sharded and credential-free", () => {
  const scrape = block("prometheus.scrape")
  for (const line of ['targets = discovery.relabel.coredns.output', 'job_name = "coredns"',
    'scheme = "http"', 'metrics_path = "/metrics"', 'scrape_interval = "30s"',
    'scrape_timeout = "10s"', 'sample_limit = 5000', 'follow_redirects = false',
    'clustering { enabled = true }', 'forward_to = [prometheus.remote_write.beacon.receiver]'])
    assert.ok(scrape.includes(line), line)
  assert.doesNotMatch(scrape, /bearer_token|authorization|tls_config|cert_file|key_file|honor_labels/)
})

test("resolver egress adds only TCP 9153 to the existing exact DNS pod selector", () => {
  const resources = parseAllDocuments(execFileSync("kubectl", ["kustomize", path], {encoding: "utf8"}))
    .map(d => d.toJSON()).filter(Boolean)
  const policy = resources.find(r => r.kind === "NetworkPolicy").spec
  assert.deepEqual(policy.egress[0], {
    to: [{namespaceSelector: {matchLabels: {"kubernetes.io/metadata.name": "kube-system"}},
      podSelector: {matchLabels: {"k8s-app": "kube-dns"}}}],
    ports: [{protocol: "UDP", port: 53}, {protocol: "TCP", port: 53}, {protocol: "TCP", port: 9153}],
  })
  assert.equal(resources.filter(r => r.kind === "ClusterRole")[0].rules.length, 2)
})
