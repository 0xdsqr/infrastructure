import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const decode = (s: string) => parseAllDocuments(s).map(d => d.toJSON()).filter(Boolean)
const render = (p: string) => decode(execFileSync("kubectl", ["kustomize", p], {encoding: "utf8"}))
const path = "gitops/components/telemetry-metrics/overlays/indigo"
const resources = render(path)
const config = resources.find(r => r.kind === "ConfigMap").data["config.alloy"] as string
const ksm = parse(readFileSync("gitops/components/kube-state-metrics/overlays/indigo/values-overrides.yaml", "utf8"))
const projects = render("gitops/components/argocd/overlays/indigo").filter(r => r.kind === "AppProject")
const applications = render("gitops/clusters/indigo/applications").flatMap(r => r.kind === "ApplicationSet" ? previewApplicationSet(r) : [r])

test("Indigo collectors are pinned manual-sync applications without changing hub-a", () => {
  for (const [name, project, chart, version] of [
    ["indigo-metrics", "platform-telemetry-metrics", "alloy", "1.13.0"],
    ["kube-state-metrics", "platform-kube-state-metrics", "kube-state-metrics", "8.6.0"],
  ]) {
    const app = applications.find(a => a.metadata.name === name)
    assert.equal(app.spec.project, project)
    assert.equal(app.spec.destination.namespace, "observability")
    assert.equal(app.spec.sources[0].chart, chart)
    assert.equal(app.spec.sources[0].targetRevision, version)
    assert.equal(app.spec.syncPolicy.automated.enabled, false)
    assert.equal(app.spec.syncPolicy.automated.prune, false)
    assert.equal(app.spec.syncPolicy.automated.selfHeal, false)
    assert.ok(app.spec.sources[1].path.endsWith("/overlays/indigo"))
    const downloads = render("gitops/components/argocd/overlays/indigo")
      .find(r => r.kind === "CiliumNetworkPolicy" && r.metadata.name === "argocd-repository-downloads")
    const hosts = downloads.spec.egress.flatMap((rule: any) => rule.toFQDNs ?? []).map((host: any) => host.matchName)
    assert.ok(hosts.includes(new URL(app.spec.sources[0].repoURL).hostname), `${name} chart repository must be reachable`)
  }
  const old = render("gitops/clusters/hub-a/applications")
  assert.equal(old.some(a => a.metadata.name === "indigo-metrics"), false)
  assert.equal(old.find(a => a.metadata.name === "k8s-monitoring").spec.sources[0].targetRevision, "4.3.1")
  assert.equal(render("gitops/components/argocd/overlays/hub-a").some(p => p.metadata.name === "platform-telemetry-metrics"), false)
})

test("collector access is only explicit node metrics and API metrics, not secrets or proxy", () => {
  const role = resources.find(r => r.kind === "ClusterRole")
  assert.equal(role.rules.length, 2)
  assert.deepEqual(role.rules[0].resources, ["nodes/metrics"])
  assert.deepEqual(role.rules[0].verbs, ["get"])
  assert.equal(role.rules[0].resourceNames.length, 9)
  assert.deepEqual(role.rules[1], {nonResourceURLs: ["/metrics"], verbs: ["get"]})
  for (const name of role.rules[0].resourceNames) assert.ok(config.includes(name))
  assert.deepEqual(resources.find(r => r.kind === "ClusterRoleBinding").subjects,
    [{kind: "ServiceAccount", name: "indigo-metrics", namespace: "observability"}])
  assert.ok(!ksm.collectors.includes("secrets"))
  assert.ok(!ksm.collectors.includes("configmaps"))
  assert.deepEqual(ksm.metricLabelsAllowlist, [])
  assert.deepEqual(ksm.metricAnnotationsAllowList, [])
})

test("metrics pipeline verifies all TLS peers, reloads mounted credentials, and shards shared scrapes", () => {
  assert.doesNotMatch(config, /insecure_skip_verify\s*=\s*true|nodes\/proxy|loki\.|otelcol\.|pyroscope\./)
  assert.match(config, /https:\/\/beacon-telemetry\.service\.home\.arpa:9443\/api\/v1\/write/)
  assert.equal((config.match(/insecure_skip_verify = false/g) ?? []).length, 4)
  assert.equal((config.match(/clustering \{ enabled = true \}/g) ?? []).length, 5)
  assert.equal((config.match(/:10250", node =/g) ?? []).length, 9)
  assert.equal((config.match(/:6443", instance =/g) ?? []).length, 3)
  assert.match(config, /external_labels = \{cluster = "indigo", env = "production"\}/)
  assert.match(config, /ca_file = "\/etc\/telemetry\/ca\/ca.crt"/)
  assert.match(config, /cert_file = "\/etc\/telemetry\/tls\/tls.crt"/)
  assert.match(config, /key_file = "\/etc\/telemetry\/tls\/tls.key"/)
  assert.doesNotMatch(config, /local\.file|key_pem|cert_pem/)
  assert.match(config, /max_keepalive_time = "1h"/)
  assert.equal((config.match(/kube-state-metrics\.observability\.svc:8080/g) ?? []).length, 1)
  assert.match(config, /job_name = "kube-state-metrics"\n  honor_labels = true/)
})

test("default-deny exceptions expose only peer membership, object metrics, and scoped egress", () => {
  const policy = resources.find(r => r.kind === "NetworkPolicy").spec
  assert.deepEqual(policy.ingress[0].ports, [{protocol: "TCP", port: 12345}])
  assert.deepEqual(policy.egress.at(-1), {to: [{ipBlock: {cidr: "10.10.30.102/32"}}], ports: [{protocol: "TCP", port: 9443}]})
  assert.equal(policy.egress.length, 7)
  const host = resources.find(r => r.kind === "CiliumNetworkPolicy").spec
  assert.deepEqual(host.egress[0], {toEntities: ["kube-apiserver"], toPorts: [{ports: [{port: "6443", protocol: "TCP"}]}]})
  assert.deepEqual(host.egress[1].toPorts, [{ports: [{port: "10250", protocol: "TCP"}]}])
  assert.equal(host.egress.length, 2)
  const ksmPolicy = render("gitops/components/kube-state-metrics/overlays/indigo").find(r => r.kind === "NetworkPolicy").spec
  assert.deepEqual(ksmPolicy.ingress, [{from: [{podSelector: {matchLabels: {"app.kubernetes.io/instance": "indigo-metrics"}}}], ports: [{protocol: "TCP", port: 8080}]}])
  assert.deepEqual(ksmPolicy.egress, [])
})

// Supply the exact unpacked chart versions to validate the real pod templates.
for (const [component, name, variable] of [
  ["telemetry-metrics", "indigo-metrics", "ALLOY_TEST_CHART"],
  ["kube-state-metrics", "kube-state-metrics", "KSM_TEST_CHART"],
]) {
  test(`${name} chart renders restricted platform-only HA pods and exact Argo permissions`, {skip: !process.env[variable]}, () => {
    const args = ["template", name, process.env[variable]!, "--namespace", "observability", "--kube-version", "1.36.3",
      "-f", `gitops/components/${component}/base/values-common.yaml`,
      "-f", `gitops/components/${component}/overlays/indigo/values-overrides.yaml`]
    const text = execFileSync("helm", args, {encoding: "utf8"})
    assert.equal(execFileSync("helm", args, {encoding: "utf8"}), text)
    const chart = decode(text)
    const deployment = chart.find(r => r.kind === "Deployment")
    assert.equal(deployment.spec.replicas, 2)
    const pod = deployment.spec.template.spec
    assert.equal(pod.securityContext.runAsNonRoot, true)
    assert.equal(pod.securityContext.seccompProfile.type, "RuntimeDefault")
    assert.equal(pod.hostNetwork ?? false, false)
    assert.equal(pod.hostPID ?? false, false)
    assert.deepEqual(pod.nodeSelector, {"platform.dsqr.dev/node-pool": "platform"})
    assert.deepEqual(pod.tolerations, [{key: "platform.dsqr.dev/dedicated", operator: "Equal", value: "platform", effect: "NoSchedule"}])
    assert.equal(pod.topologySpreadConstraints[0].minDomains, 2)
    assert.equal(pod.topologySpreadConstraints[0].nodeTaintsPolicy, "Honor")
    assert.deepEqual(pod.topologySpreadConstraints[0].labelSelector.matchLabels, deployment.spec.selector.matchLabels)
    assert.equal(chart.find(r => r.kind === "PodDisruptionBudget").spec.minAvailable, 1)
    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      assert.equal(c.securityContext.allowPrivilegeEscalation, false)
      assert.equal(c.securityContext.readOnlyRootFilesystem, true)
      assert.deepEqual(c.securityContext.capabilities.drop, ["ALL"])
      assert.ok(!c.securityContext.capabilities.add?.length)
      assert.ok(c.resources.requests.cpu)
      assert.ok(c.resources.limits.memory)
      for (const mount of c.volumeMounts ?? []) assert.equal(mount.subPath, undefined)
    }
    assert.equal(chart.some(r => ["Secret", "CustomResourceDefinition", "DaemonSet"].includes(r.kind)), false)
    assert.equal((pod.volumes ?? []).some((v: {hostPath?: unknown}) => v.hostPath), false)
    const app = applications.find(a => a.metadata.name === name)
    const project = projects.find(p => p.metadata.name === app.spec.project)
    for (const r of [...chart, ...render(`gitops/components/${component}/overlays/indigo`)]) {
      const group = r.apiVersion.includes("/") ? r.apiVersion.split("/")[0] : ""
      const clusterScoped = ["ClusterRole", "ClusterRoleBinding"].includes(r.kind)
      const whitelist = clusterScoped ? project.spec.clusterResourceWhitelist : project.spec.namespaceResourceWhitelist
      assert.ok(whitelist.some((p: {group: string; kind: string; name?: string}) => p.group === group && p.kind === r.kind && (!clusterScoped || p.name === r.metadata.name)), `${r.kind}/${r.metadata.name}`)
    }
    if (name === "indigo-metrics") {
      assert.ok(pod.containers[0].args.includes("--cluster.enabled=true"))
      assert.equal(chart.some(r => r.kind === "ClusterRole"), false)
      assert.equal(pod.volumes.find((v: {name: string}) => v.name === "telemetry-tls").secret.secretName, "telemetry-client-tls")
      assert.equal(pod.volumes.find((v: {name: string}) => v.name === "data").emptyDir.sizeLimit, "2Gi")
      assert.ok(!pod.containers[1].volumeMounts.some((m: {name: string}) => m.name === "telemetry-tls"))
    } else {
      for (const rule of chart.find(r => r.kind === "ClusterRole").rules) {
        assert.deepEqual(rule.verbs, ["list", "watch"])
        assert.ok(!rule.resources.includes("secrets") && !rule.resources.includes("configmaps"))
      }
    }
  })
}
