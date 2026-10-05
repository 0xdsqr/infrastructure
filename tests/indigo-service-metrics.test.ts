import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const decode = (s: string) => parseAllDocuments(s).map(d => d.toJSON()).filter(Boolean)
const render = (p: string) => decode(execFileSync("kubectl", ["kustomize", p], {encoding: "utf8"}))
const config = readFileSync("gitops/components/telemetry-metrics/overlays/indigo/config.alloy", "utf8")
const components = [
  ["external_secrets", "external-secrets", ["external-secrets;metrics;8080", "external-secrets-cert-controller;metrics;8080", "external-secrets-webhook;metrics;8080"]],
  ["envoy_gateway", "envoy-gateway-system", ["gateway-helm;metrics;19001"]],
  ["envoy_proxy", "envoy-gateway-system", ["envoy;metrics;19001"]],
] as const
const collector = {
  "k8s:io.kubernetes.pod.namespace": "observability",
  "app.kubernetes.io/instance": "indigo-metrics",
  "app.kubernetes.io/name": "alloy",
}

test("service discovery is namespace-scoped and selects only the intended components and metrics ports", () => {
  assert.equal((config.match(/discovery.kubernetes "/g) ?? []).length, 5)
  for (const [name, ns, accepted] of components) {
    const discovery = config.split(`discovery.kubernetes "${name}" {`)[1].split("discovery.relabel")[0]
    assert.ok(discovery.includes(`namespaces { names = ["${ns}"] }`))
    assert.match(discovery, /role = "pod"/)
    const relabel = config.split(`discovery.relabel "${name}" {`)[1].split("prometheus.scrape")[0]
    const rule = [...relabel.matchAll(/rule \{([^}]+)\}/g)].find(([, r]) => r.includes("container_port_number"))![1]
    const regex = new RegExp(`^(?:${JSON.parse(rule.match(/regex = ("[^"]+")/)![1])})$`)
    for (const tuple of accepted) assert.ok(regex.test(tuple))
    for (const tuple of ["envoy;admin;19000", "envoy;readiness;19003", "gateway-helm;grpc;18000",
      "gateway-helm;webhook;9443", "external-secrets-webhook;webhook;10250", "unrelated;metrics;8080"]) {
      assert.equal(regex.test(tuple), false, tuple)
    }
    assert.match(relabel, /regex = "Running"/)
    assert.match(relabel, /container_init"\]\s+regex = "false"/)
    assert.doesNotMatch(relabel, /pod_ready|labelmap/)
    for (const label of ["namespace", "pod", "instance", "job"]) assert.ok(relabel.includes(`target_label = "${label}"`))
    const scrape = config.split(`prometheus.scrape "${name}" {`)[1].split("\n}\n")[0]
    assert.match(scrape, /clustering \{ enabled = true \}/)
    assert.match(scrape, /sample_limit = 10000/)
    assert.match(scrape, /scrape_interval = "30s"/)
    assert.ok(scrape.includes(`metrics_path = "${name === "envoy_proxy" ? "/stats/prometheus" : "/metrics"}"`))
    assert.doesNotMatch(scrape, /bearer_token|authorization|honor_labels/)
  }
  assert.ok(config.includes("app.kubernetes.io/instance=external-secrets,app.kubernetes.io/name in (external-secrets,external-secrets-cert-controller,external-secrets-webhook)"))
  assert.ok(config.includes("app.kubernetes.io/instance=envoy-gateway,app.kubernetes.io/name=gateway-helm,control-plane=envoy-gateway"))
  assert.ok(config.includes("app.kubernetes.io/name=envoy,app.kubernetes.io/component=proxy,gateway.envoyproxy.io/owning-gateway-name=shared,gateway.envoyproxy.io/owning-gateway-namespace=gateway-system"))
})

test("existing service ingress changes only collector identity; admission, xDS, health and Vault rules are unchanged", () => {
  for (const [overlay, file, name] of [
    ["external-secrets-config", "operator", "external-secrets-operator-access"],
    ["gateway", "controller", "envoy-gateway-controller-access"],
    ["gateway", "proxy", "envoy-shared-proxy-access"],
  ]) {
    const original = parse(readFileSync(`gitops/components/${overlay}/network-policy/${file}.ciliumnetworkpolicy.yaml`, "utf8"))
    const current = render(`gitops/components/${overlay}/overlays/indigo`).find(r => r.metadata.name === name)
    const ingress = original.spec.ingress.find((r: any) => r.fromEndpoints?.some((e: any) =>
      e.matchLabels?.["k8s:io.kubernetes.pod.namespace"] === "observability"))
    ingress.fromEndpoints = [{matchLabels: collector}]
    assert.deepEqual(current.spec, original.spec)
  }
  const egress = render("gitops/components/telemetry-metrics/overlays/indigo")
    .find(r => r.kind === "NetworkPolicy").spec.egress
    .filter((r: any) => r.to.some((t: any) => ["external-secrets", "envoy-gateway-system"]
      .includes(t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"])))
  assert.equal(egress.length, 3)
  assert.deepEqual(egress.map((r: any) => r.ports), [
    [{protocol: "TCP", port: 8080}], [{protocol: "TCP", port: 19001}], [{protocol: "TCP", port: 19001}],
  ])
  assert.deepEqual(egress[0].to[0].podSelector, {
    matchLabels: {"app.kubernetes.io/instance": "external-secrets"},
    matchExpressions: [{key: "app.kubernetes.io/name", operator: "In",
      values: ["external-secrets", "external-secrets-cert-controller", "external-secrets-webhook"]}],
  })
  assert.deepEqual(egress[1].to[0].podSelector.matchLabels, {
    "app.kubernetes.io/instance": "envoy-gateway", "app.kubernetes.io/name": "gateway-helm", "control-plane": "envoy-gateway",
  })
  assert.deepEqual(egress[2].to[0].podSelector.matchLabels, {
    "app.kubernetes.io/name": "envoy", "app.kubernetes.io/component": "proxy",
    "gateway.envoyproxy.io/owning-gateway-name": "shared", "gateway.envoyproxy.io/owning-gateway-namespace": "gateway-system",
  })
})

test("discovery grants are pod list/watch only, owned by existing manually synced applications", () => {
  const roles = [
    parse(readFileSync("gitops/components/external-secrets/overlays/indigo/values-overrides.yaml", "utf8")).extraObjects,
    render("gitops/components/envoy-gateway/overlays/indigo"),
  ]
  const projects = render("gitops/components/argocd/overlays/indigo")
  const apps = render("gitops/clusters/indigo/applications").flatMap(r => r.kind === "ApplicationSet" ? previewApplicationSet(r) : [r])
  for (const [i, ns] of ["external-secrets", "envoy-gateway-system"].entries()) {
    const [role, binding] = ["Role", "RoleBinding"].map(kind => roles[i].find((r: any) => r.kind === kind))
    assert.equal(roles[i].length, 2)
    assert.equal(role.metadata.namespace, ns)
    assert.deepEqual(role.rules, [{apiGroups: [""], resources: ["pods"], verbs: ["list", "watch"]}])
    assert.deepEqual(binding.roleRef, {apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name})
    assert.deepEqual(binding.subjects, [{kind: "ServiceAccount", name: "indigo-metrics", namespace: "observability"}])
    const name = i === 0 ? "external-secrets" : "envoy-gateway"
    const app = apps.find(a => a.metadata.name === name)
    assert.equal(app.spec.syncPolicy.automated.enabled, false)
    const project = projects.find(p => p.kind === "AppProject" && p.metadata.name === app.spec.project)
    for (const kind of ["Role", "RoleBinding"]) assert.ok(project.spec.namespaceResourceWhitelist.some((r: any) => r.kind === kind))
    if (i === 1) {
      assert.equal(app.spec.sources.length, 3)
      assert.equal(app.spec.sources[2].path, "gitops/components/envoy-gateway/overlays/indigo")
      assert.deepEqual(app.spec.sources.slice(0, 2).map((s: any) => s.targetRevision), ["v1.9.1", "v1.9.1"])
    }
  }
})

test("pinned ESO render adds only two discovery resources, leaving workloads and hub-a unchanged",
  {skip: !process.env.EXTERNAL_SECRETS_TEST_CHART}, () => {
    const dir = mkdtempSync(join(tmpdir(), "eso-metrics-test-"))
    const common = "gitops/components/external-secrets/base/values-common.yaml"
    const overlay = "gitops/components/external-secrets/overlays/indigo/values-overrides.yaml"
    const helm = (values: string) => decode(execFileSync("helm", ["template", "external-secrets", process.env.EXTERNAL_SECRETS_TEST_CHART!,
      "--namespace", "external-secrets", "--kube-version", "1.36.3", "-f", common, "-f", values], {encoding: "utf8", maxBuffer: 32 * 1024 * 1024}))
    try {
      const before = join(dir, "before.yaml")
      writeFileSync(before, execFileSync("git", ["show", `87ffeba6da6a4c58c3ded40efbfb030f0fe0659f:${overlay}`]))
      const current = helm(overlay)
      const added = current.filter(r => r.metadata.name === "indigo-metrics-discovery")
      assert.equal(added.length, 2)
      assert.deepEqual(current.filter(r => r.metadata.name !== "indigo-metrics-discovery"), helm(before))
      assert.equal(helm("gitops/components/external-secrets/overlays/hub-a/values-overrides.yaml")
        .some(r => r.metadata.name === "indigo-metrics-discovery"), false)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })
