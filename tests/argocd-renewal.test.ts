import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const yaml = (text: string) => parseAllDocuments(text).map(doc => doc.toJSON()).filter(Boolean)
const render = (path: string) => yaml(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" }))
const helm = (component: string, chart: string) => yaml(execFileSync("helm", [
  "template", component, chart, "--namespace", "argocd",
  "--values", `gitops/components/${component}/base/values-common.yaml`,
  "--values", `gitops/components/${component}/overlays/indigo/values-overrides.yaml`,
], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }))
const names = ["argocd-repo-server", "argocd-server", "argocd-applicationset-controller", "argocd-application-controller"]
const marker = "/spec/template/metadata/annotations/reloader.stakater.com~1last-reloaded-from"

test("renewal is one generated manually approved Application with narrow Argo drift exclusions", () => {
  const apps = previewApplicationSet(render("gitops/clusters/indigo/applications")[0]) as any[]
  const reloader = apps.find(app => app.metadata.name === "reloader")
  assert.equal(reloader.spec.project, "platform-reloader")
  assert.equal(reloader.spec.syncPolicy.automated.enabled, false)
  assert.equal(reloader.spec.sources.length, 2)
  const chart = reloader.spec.sources.find(source => source.chart)
  assert.equal(chart.repoURL, "https://stakater.github.io/stakater-charts")
  assert.equal(chart.targetRevision, "2.2.17")
  assert.equal(chart.chart, "reloader")
  const manifests = reloader.spec.sources.find(source => source.ref === "values")
  assert.equal(manifests.path, "gitops/components/reloader/overlays/indigo")
  const argo = apps.find(app => app.metadata.name === "argocd")
  assert.equal(argo.spec.syncPolicy.automated.enabled, false)
  assert.ok(argo.spec.syncPolicy.syncOptions.includes("RespectIgnoreDifferences=true"))
  assert.deepEqual(argo.spec.ignoreDifferences.map(rule => rule.name), names)
  for (const rule of argo.spec.ignoreDifferences) {
    assert.equal(rule.namespace, "argocd")
    assert.deepEqual(rule.jsonPointers, [marker])
  }
  for (const app of apps.filter(app => app !== reloader)) {
    assert.equal(app.spec.sources?.find(source => source.ref === "values")?.path, undefined)
  }
})

test("Reloader may mutate only enrolled workloads and has no cluster-wide RBAC or open egress", () => {
  const resources = render("gitops/components/reloader/overlays/indigo")
  assert.ok(resources.every(resource => resource.metadata.namespace === "argocd"))
  assert.ok(!resources.some(resource => resource.kind.startsWith("Cluster")))
  const role = resources.find(resource => resource.kind === "Role")
  const mutations = role.rules.filter(rule => rule.apiGroups.includes("apps") && rule.verbs.includes("update"))
  assert.deepEqual(mutations.flatMap(rule => rule.resourceNames), names)
  assert.ok(role.rules.every(rule => !rule.verbs.includes("delete")))
  const binding = resources.find(resource => resource.kind === "RoleBinding")
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "reloader", namespace: "argocd" }])
  const deny = resources.find(resource => resource.kind === "NetworkPolicy").spec
  assert.deepEqual(deny.policyTypes, ["Ingress", "Egress"])
  assert.deepEqual(deny.ingress, [])
  assert.deepEqual(deny.egress, [])
  const allow = resources.find(resource => resource.kind === "CiliumNetworkPolicy").spec
  assert.deepEqual(allow.endpointSelector.matchLabels, deny.podSelector.matchLabels)
  assert.equal(allow.egress.length, 2)
  assert.deepEqual(allow.egress[0], { toEntities: ["kube-apiserver"], toPorts: [{ ports: [{ port: "6443", protocol: "TCP" }] }] })
  assert.deepEqual(allow.egress[1].toEndpoints, [{ matchLabels: {
    "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s:k8s-app": "kube-dns",
  } }])
  assert.deepEqual(allow.egress[1].toPorts[0].ports, [{ port: "53", protocol: "UDP" }, { port: "53", protocol: "TCP" }])
})

test("pinned Argo chart isolates serving keys and enables each client's strict TLS verification", {
  skip: !process.env.ARGOCD_TEST_CHART,
}, () => {
  const resources = helm("argocd", process.env.ARGOCD_TEST_CHART!)
  const params = resources.find(resource => resource.metadata.name === "argocd-cmd-params-cm").data
  assert.equal(params["repo.server"], "argocd-repo-server.argocd.svc.cluster.local:8081")
  for (const client of ["server", "controller", "applicationsetcontroller"]) {
    assert.equal(params[`${client}.repo.server.strict.tls`], "true")
    assert.equal(params[`${client}.repo.server.plaintext`], "false")
  }
  for (const [index, name] of names.entries()) {
    const workload = resources.find(resource => ["Deployment", "StatefulSet"].includes(resource.kind) && resource.metadata.name === name)
    assert.ok(workload, name)
    const pod = workload.spec.template.spec
    const container = pod.containers[0]
    const env = container.env.filter(item => item.name === "ARGOCD_APP_CONF_PATH")
    assert.deepEqual(env, [{ name: "ARGOCD_APP_CONF_PATH", value: "/app/dsqr-tls" }])
    assert.equal(new Set(pod.volumes.map(volume => volume.name)).size, pod.volumes.length)
    assert.equal(new Set(container.volumeMounts.map(mount => mount.mountPath)).size, container.volumeMounts.length)
    const mount = container.volumeMounts.find(mount => mount.mountPath.startsWith("/app/dsqr-tls/"))
    assert.equal(mount.mountPath, `/app/dsqr-tls/${["reposerver", "server", "reposerver", "controller"][index]}/tls`)
    assert.equal(mount.readOnly, true)
    const volume = pod.volumes.find(volume => volume.name === mount.name)
    if (index === 0) {
      assert.equal(volume.secret.secretName, "argocd-repo-server-serving-tls")
      assert.deepEqual(volume.secret.items.map(item => item.key), ["tls.crt", "tls.key"])
      assert.equal(workload.metadata.annotations["secret.reloader.stakater.com/reload"], "argocd-repo-server-serving-tls")
      assert.deepEqual(workload.spec.strategy, { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } })
    } else {
      const strict = container.env.filter(item => item.valueFrom?.configMapKeyRef?.key?.endsWith(".repo.server.strict.tls"))
      assert.equal(strict.length, 1, `${name} must consume its strict TLS setting`)
      assert.equal(strict[0].valueFrom.configMapKeyRef.name, "argocd-cmd-params-cm")
      assert.equal(params[strict[0].valueFrom.configMapKeyRef.key], "true")
      assert.equal(volume.configMap.name, "dsqr-home-root-ca")
      assert.deepEqual(volume.configMap.items, [{ key: "ca.crt", path: "ca.crt" }])
      assert.equal(pod.volumes.some(volume => volume.secret?.secretName === "argocd-repo-server-serving-tls"), false)
      assert.equal(workload.metadata.annotations["configmap.reloader.stakater.com/reload"], "dsqr-home-root-ca")
    }
  }
  assert.equal(resources.some(resource => resource.kind === "Secret" && resource.metadata.name === "argocd-repo-server-tls"), false)
})

test("pinned Reloader chart scopes its watch and uses GitOps-compatible explicit reloads", {
  skip: !process.env.RELOADER_TEST_CHART,
}, () => {
  const resources = helm("reloader", process.env.RELOADER_TEST_CHART!)
  assert.deepEqual(resources.map(resource => resource.kind).sort(), ["Deployment", "ServiceAccount"])
  const pod = resources.find(resource => resource.kind === "Deployment").spec.template.spec
  const container = pod.containers[0]
  assert.equal(pod.serviceAccountName, "reloader")
  assert.equal(container.image, "ghcr.io/stakater/reloader:v1.4.22")
  assert.ok(container.args.includes("--reload-strategy=annotations"))
  assert.ok(container.args.includes("--resource-label-selector=platform.dsqr.dev/tls-reload=true"))
  assert.ok(container.args.includes("--sync-after-restart=true"))
  assert.ok(container.args.includes("--reload-on-create=true"))
  assert.ok(container.args.includes("--ignored-workload-types=jobs,cronjobs"))
  assert.ok(!container.args.some(arg => /auto-reload-all=true|reload-on-delete=true/.test(arg)))
  assert.ok(container.env.some(env => env.name === "KUBERNETES_NAMESPACE" && env.valueFrom.fieldRef.fieldPath === "metadata.namespace"))
  assert.equal(pod.securityContext.runAsNonRoot, true)
  assert.equal(container.securityContext.allowPrivilegeEscalation, false)
  assert.equal(container.securityContext.readOnlyRootFilesystem, true)
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"])
})
