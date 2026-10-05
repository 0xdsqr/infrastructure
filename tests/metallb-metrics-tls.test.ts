import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { vault } from "../infra/vault/config.ts"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const path = "gitops/components/metallb/metrics-tls"
const decode = (text: string) => parseAllDocuments(text).map(d => d.toJSON()).filter(Boolean)
const kustomize = (p: string) => decode(execFileSync("kubectl", ["kustomize", p], { encoding: "utf8" }))
const prepared = kustomize(`${path}/overlays/indigo`)
const get = (kind: string, name: string) => {
  const matches = prepared.filter(o => o.kind === kind && o.metadata.name === name)
  assert.equal(matches.length, 1, `${kind}/${name}`)
  return matches[0]
}

for (const [component, issuer] of [
  ["controller", vault.pkiIssuers.indigoMetallbControllerMetrics],
  ["speaker", vault.pkiIssuers.indigoMetallbSpeakerMetrics],
] as const) {
  test(`MetalLB ${component} issuer is bound to one identity and exact server name`, () => {
    const name = `metallb-${component}-metrics`
    const sa = `${name}-issuer`
    const secret = `${name}-tls`
    assert.equal(issuer.backend, "pki_int")
    assert.deepEqual(issuer.allowedDomains, [`${name}.metallb-system.svc`])
    assert.equal(issuer.allowWildcardCertificates, false)
    assert.equal(issuer.generateLease, false)
    assert.equal(issuer.ttlHours, 720)
    assert.equal(issuer.maxTtlHours, 720)
    assert.deepEqual(issuer.kubernetesAuthRole.boundServiceAccountNames, [sa])
    assert.deepEqual(issuer.kubernetesAuthRole.boundServiceAccountNamespaces, ["metallb-system"])
    assert.equal(issuer.kubernetesAuthRole.tokenTtlSeconds, 1200)
    assert.equal(issuer.kubernetesAuthRole.tokenExplicitMaxTtlSeconds, 3600)
    const generator = get("VaultDynamicSecret", secret).spec
    assert.equal(generator.path, `${issuer.backend}/issue/${issuer.roleName}`)
    assert.equal(generator.method, "POST")
    assert.deepEqual(generator.parameters, { common_name: issuer.allowedDomains[0], ttl: "720h" })
    assert.equal(generator.provider.server, "https://vault.service.home.arpa:8200")
    assert.deepEqual(generator.provider.caProvider, { type: "ConfigMap", name: "dsqr-home-root-ca", key: "ca.crt" })
    assert.deepEqual(generator.provider.auth.kubernetes, {
      mountPath: issuer.kubernetesAuthRole.backend,
      role: issuer.kubernetesAuthRole.roleName, serviceAccountRef: { name: sa },
    })
    assert.equal(get("ServiceAccount", sa).automountServiceAccountToken, false)
    const binding = get("ClusterRoleBinding", `${sa}-auth-delegator`)
    assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: sa, namespace: "metallb-system" }])
    assert.deepEqual(binding.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "system:auth-delegator" })
    const es = get("ExternalSecret", secret).spec
    assert.equal(es.refreshPolicy, "Periodic")
    assert.equal(es.refreshInterval, "240h")
    assert.equal(es.target.name, secret)
    assert.equal(es.target.creationPolicy, "Owner")
    assert.equal(es.target.deletionPolicy, "Retain")
    assert.equal(es.target.template.type, "kubernetes.io/tls")
    assert.equal(es.target.template.metadata.labels["platform.dsqr.dev/cluster"], "indigo")
    assert.deepEqual(es.target.template.data, {
      "tls.crt": "{{ .certificate }}\n{{ .issuing_ca }}\n",
      "tls.key": "{{ .private_key }}\n", "ca.crt": "{{ .issuing_ca }}\n",
    })
    assert.deepEqual(es.dataFrom, [{ sourceRef: { generatorRef: {
      apiVersion: "generators.external-secrets.io/v1alpha1", kind: "VaultDynamicSecret", name: secret,
    } } }])
  })
}

test("issuance has one GitOps owner while serving cutover stays manual", () => {
  assert.equal(prepared.length, 9)
  assert.equal(new X509Certificate(get("ConfigMap", "dsqr-home-root-ca").data["ca.crt"]).ca, true)
  for (const obj of prepared) {
    if (obj.kind !== "ClusterRoleBinding") assert.equal(obj.metadata.namespace, "metallb-system")
    assert.ok(["ConfigMap", "ServiceAccount", "ClusterRoleBinding", "VaultDynamicSecret", "ExternalSecret"].includes(obj.kind))
  }
  const active = kustomize("gitops/components/external-secrets-config/overlays/indigo")
  for (const obj of prepared) {
    const matches = active.filter(o => o.kind === obj.kind && o.metadata.name === obj.metadata.name && o.metadata.namespace === obj.metadata.namespace)
    assert.equal(matches.length, 1)
    // The owning application's existing network-policy component stamps
    // declaration ownership labels; certificate template labels stay intact.
    const owned = structuredClone(obj)
    owned.metadata.labels["app.kubernetes.io/part-of"] = "cluster-secrets"
    owned.metadata.labels["platform.dsqr.dev/tier"] = "platform-policy"
    assert.deepEqual(matches[0], owned)
  }
  assert.equal(kustomize("gitops/components/external-secrets-config/overlays/hub-a")
    .some(o => /metallb.*metrics/.test(o.metadata.name)), false)
  const project = kustomize("gitops/components/argocd/overlays/indigo")
    .find(o => o.kind === "AppProject" && o.metadata.name === "secrets").spec
  assert.ok(project.destinations.some((d: any) => d.namespace === "metallb-system" && d.server === "https://kubernetes.default.svc"))
  assert.deepEqual(project.clusterResourceWhitelist.filter((r: any) => r.name?.startsWith("metallb-")), [
    { group: "rbac.authorization.k8s.io", kind: "ClusterRoleBinding", name: "metallb-controller-metrics-issuer-auth-delegator" },
    { group: "rbac.authorization.k8s.io", kind: "ClusterRoleBinding", name: "metallb-speaker-metrics-issuer-auth-delegator" },
  ])
  assert.ok(project.clusterResourceWhitelist.every((r: any) => r.name && !r.name.includes("*")))
  const ksm = kustomize("gitops/components/argocd/overlays/indigo")
    .find(o => o.kind === "AppProject" && o.metadata.name === "platform-kube-state-metrics")
  assert.deepEqual(ksm.spec.destinations, [{ namespace: "observability", server: "https://kubernetes.default.svc" }])
  const apps = kustomize("gitops/clusters/indigo/applications")
    .flatMap(o => o.kind === "ApplicationSet" ? previewApplicationSet(o) : [o])
  assert.equal(apps.find(o => o.metadata.name === "external-secrets-config").spec.source.path,
    "gitops/components/external-secrets-config/overlays/indigo")
  const metallb = apps.find(o => o.metadata.name === "metallb")
  assert.equal(metallb.spec.syncPolicy.automated.enabled, false)
  assert.equal(JSON.stringify(metallb).includes("values-provided.yaml"), false)
  const activeValues = parse(readFileSync("gitops/components/metallb/overlays/indigo/values-overrides.yaml", "utf8"))
  assert.equal(activeValues.tls?.controllerMetricsTLSSecret, undefined)
  assert.equal(activeValues.tls?.speakerMetricsTLSSecret, undefined)
  assert.doesNotMatch(readFileSync("gitops/components/application-set/overlays/indigo/inventory.yaml", "utf8"), /metrics-tls/)
})

test("pinned MetalLB chart cutover changes only directory-mounted serving certificates", {
  skip: !process.env.METALLB_TEST_CHART,
}, () => {
  const args = ["template", "metallb", process.env.METALLB_TEST_CHART!, "--namespace", "metallb-system",
    "-f", "gitops/components/metallb/base/values-common.yaml",
    "-f", "gitops/components/metallb/overlays/indigo/values-overrides.yaml"]
  const before = decode(execFileSync("helm", args, { encoding: "utf8" }))
  const after = decode(execFileSync("helm", [...args, "-f", `${path}/values-provided.yaml`], { encoding: "utf8" }))
  for (const [component, kind] of [["controller", "Deployment"], ["speaker", "DaemonSet"]]) {
    const resource = after.find(o => o.kind === kind && o.metadata.name === `metallb-${component}`)
    const pod = resource.spec.template.spec
    const container = pod.containers.find((c: any) => c.name === component)
    assert.ok(container.args.includes("--metrics-cert-dir=/etc/metrics"))
    const mount = container.volumeMounts.find((v: any) => v.name === "metrics-certs")
    assert.deepEqual(mount, { name: "metrics-certs", mountPath: "/etc/metrics", readOnly: true })
    const volume = pod.volumes.find((v: any) => v.name === "metrics-certs")
    assert.equal(volume.secret.secretName, `metallb-${component}-metrics-tls`)
    assert.notEqual(volume.secret.optional, true)
    // Remove only the three intentional changes, then compare all resources.
    container.args = container.args.filter((s: string) => s !== "--metrics-cert-dir=/etc/metrics")
    container.volumeMounts = container.volumeMounts.filter((v: any) => v.name !== "metrics-certs")
    pod.volumes = pod.volumes.filter((v: any) => v.name !== "metrics-certs")
  }
  assert.deepEqual(after, before)
})
