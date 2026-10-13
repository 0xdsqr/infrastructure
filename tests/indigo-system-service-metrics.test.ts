import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const path = "gitops/components/telemetry-metrics/overlays/indigo"
const config = readFileSync(`${path}/config.alloy`, "utf8")
const render = (p: string) => parseAllDocuments(execFileSync("kubectl", ["kustomize", p], { encoding: "utf8" }))
  .map(d => d.toJSON()).filter(Boolean)
const resources = render(path)
const block = (type: string, name: string) => config.split(`${type} "${name}" {`)[1].split("\n}\n")[0]
const components = [
  ["csr_approver", "kubelet-csr-approver", "metrics", "8080", 3000],
  ["metrics_server", "metrics-server", "https", "10250", 5000],
] as const

test("system service discovery reuses pod-only kube-system access and keeps exact release/container/ports", () => {
  const discovery = block("discovery.kubernetes", "system_services")
  assert.ok(discovery.includes('namespaces { names = ["kube-system"] }'))
  assert.ok(discovery.includes("app.kubernetes.io/name in (kubelet-csr-approver,metrics-server),app.kubernetes.io/instance in (kubelet-csr-approver,metrics-server)"))
  const role = render("gitops/components/cilium/overlays/indigo").find(r => r.kind === "Role")
  assert.deepEqual(role.rules, [{ apiGroups: [""], resources: ["pods"], verbs: ["list", "watch"] }])
  for (const [name, release, port, number] of components) {
    const relabel = block("discovery.relabel", name)
    assert.ok(relabel.includes("targets = discovery.kubernetes.system_services.targets"))
    const rules = [...relabel.matchAll(/rule \{([^}]+)\}/g)].map(([, r]) => r)
    const filter = rules.find(r => r.includes("container_port_number"))!
    const regex = new RegExp(`^(?:${JSON.parse(filter.match(/regex = ("[^"]+")/)![1])})$`)
    assert.ok(regex.test(`${release};${release};${release};${port};${number}`))
    for (const tuple of [`${release};other;${release};${port};${number}`, `${release};${release};sidecar;${port};${number}`,
      `${release};${release};${release};health;8081`, `${release};${release};${release};${port};443`])
      assert.equal(regex.test(tuple), false)
    assert.match(relabel, /regex = "Running"/)
    assert.match(relabel, /container_init"\]\s+regex = "false"/)
    assert.doesNotMatch(relabel, /pod_ready|labelmap/)
    for (const label of ["namespace", "pod", "node", "instance"]) assert.ok(relabel.includes(`target_label = "${label}"`))
  }
})

test("each replica has a bounded clustered scrape; HTTP cannot receive credentials", () => {
  for (const [name, job, , , limit] of components) {
    const scrape = block("prometheus.scrape", name)
    for (const line of [`targets = discovery.relabel.${name}.output`, `job_name = "${job}"`,
      'metrics_path = "/metrics"', 'scrape_interval = "30s"', 'scrape_timeout = "10s"',
      `sample_limit = ${limit}`, 'follow_redirects = false', 'clustering { enabled = true }',
      'forward_to = [prometheus.remote_write.beacon.receiver]']) assert.ok(scrape.includes(line), line)
    assert.doesNotMatch(scrape, /honor_labels|bearer_token\s*=|cert_file|key_file/)
  }
  const csr = block("prometheus.scrape", "csr_approver")
  assert.match(csr, /scheme = "http"/)
  assert.doesNotMatch(csr, /bearer_token|authorization|tls_config/)
})

test("metrics-server authenticates only after verifying the existing issuer identity", () => {
  const scrape = block("prometheus.scrape", "metrics_server")
  for (const line of ['scheme = "https"', 'bearer_token_file = "/var/run/secrets/kubernetes.io/serviceaccount/token"',
    'ca_file = "/etc/telemetry/ca/ca.crt"', 'server_name = "metrics-server.kube-system.svc"',
    'insecure_skip_verify = false', 'min_version = "TLS12"']) assert.ok(scrape.includes(line), line)
  const issuer = parse(readFileSync("gitops/components/metrics-server/serving-tls/overlays/indigo/server.vaultdynamicsecret.yaml", "utf8"))
  assert.equal(issuer.spec.parameters.common_name, "metrics-server.kube-system.svc")
  const role = resources.find(r => r.kind === "ClusterRole")
  assert.equal(role.rules.length, 2)
  assert.deepEqual(role.rules[1], { nonResourceURLs: ["/metrics"], verbs: ["get"] })
  assert.equal(role.rules.some((r: any) => r.apiGroups?.includes("metrics.k8s.io")), false)
})

test("collector grants exactly two pod-scoped egress paths, never CSR health or a broad kube-system allowance", () => {
  const rules = resources.find(r => r.kind === "NetworkPolicy").spec.egress
  const systemRules = rules.filter((r: any) => r.to.some((t: any) =>
    t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "kube-system"))
  assert.equal(systemRules.length, 3) // Existing DNS, plus the two new listeners.
  for (const [, release, , port] of components) {
    const selected = systemRules.filter((r: any) => r.to.some((t: any) => t.podSelector?.matchLabels?.["app.kubernetes.io/name"] === release))
    assert.deepEqual(selected, [{
      to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
        podSelector: { matchLabels: { "app.kubernetes.io/name": release, "app.kubernetes.io/instance": release } } }],
      ports: [{ protocol: "TCP", port: Number(port) }],
    }])
  }
})

test("existing service charts and collector remain manual; no new source or upgrade is introduced", () => {
  const apps = render("gitops/clusters/indigo/applications").flatMap(r => previewApplicationSet(r))
  for (const [name, version] of [["kubelet-csr-approver", "1.2.14"], ["metrics-server", "3.13.1"], ["indigo-metrics", "1.13.0"]]) {
    const app = apps.find(a => a.metadata.name === name)
    assert.equal(app.spec.sources[0].targetRevision, version)
    assert.equal(app.spec.syncPolicy.automated.enabled, false)
    assert.equal(app.spec.syncPolicy.automated.prune, false)
    assert.equal(app.spec.sources.length, 2)
  }
})
