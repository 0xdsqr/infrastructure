import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parseAllDocuments } from "yaml"
import { vault } from "../infra/vault/config.ts"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const render = (path: string) => parseAllDocuments(
  execFileSync("kubectl", ["kustomize", path], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }),
).map(d => d.toJSON()).filter(Boolean)
const secrets = render("gitops/components/external-secrets-config/overlays/indigo")
const foundation = render("gitops/components/cluster-foundation/overlays/indigo")
const resource = (kind: string, name: string, namespace?: string) => {
  const matches = secrets.filter(r => r.kind === kind && r.metadata.name === name && r.metadata.namespace === namespace)
  assert.equal(matches.length, 1, `${kind}/${namespace ?? ""}/${name}`)
  return matches[0]
}

test("telemetry issuance matches the applied client-only Vault identity and scoped login", () => {
  const role = vault.pkiIssuers.indigoTelemetryClient
  const generator = resource("VaultDynamicSecret", "telemetry-client-tls", "observability").spec
  assert.equal(role.certificatePurpose, "client")
  assert.deepEqual(role.allowedDomains, ["indigo.telemetry-client.home.arpa"])
  assert.equal(role.allowWildcardCertificates, false)
  assert.equal(role.generateLease, false)
  assert.equal(generator.path, `${role.backend}/issue/${role.roleName}`)
  assert.equal(generator.method, "POST")
  assert.equal(generator.resultType, "Data")
  assert.deepEqual(generator.parameters, { common_name: role.allowedDomains[0], ttl: `${role.ttlHours}h` })
  assert.equal(generator.provider.server, "https://vault.service.home.arpa:8200")
  assert.deepEqual(generator.provider.caProvider, { type: "ConfigMap", name: "dsqr-home-root-ca", key: "ca.crt" })
  assert.deepEqual(generator.provider.auth, { kubernetes: {
    mountPath: role.kubernetesAuthRole.backend,
    role: role.kubernetesAuthRole.roleName,
    serviceAccountRef: { name: role.kubernetesAuthRole.boundServiceAccountNames[0] },
  } })
  assert.deepEqual(role.kubernetesAuthRole.boundServiceAccountNamespaces, ["observability"])
})

test("telemetry issuer has no automounted token and uses only the existing auth-delegator pattern", () => {
  assert.equal(resource("ServiceAccount", "telemetry-client-issuer", "observability").automountServiceAccountToken, false)
  const binding = resource("ClusterRoleBinding", "telemetry-client-issuer-auth-delegator")
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "telemetry-client-issuer", namespace: "observability" }])
  assert.deepEqual(binding.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "system:auth-delegator" })
  assert.equal(secrets.some(r => r.kind === "Secret" && r.metadata.namespace === "observability"), false)
})

test("telemetry credentials reissue early and preserve an independent root trust bundle", () => {
  const spec = resource("ExternalSecret", "telemetry-client-tls", "observability").spec
  assert.equal(spec.refreshPolicy, "Periodic")
  assert.equal(spec.refreshInterval, "240h")
  assert.ok(Number.parseInt(spec.refreshInterval) < vault.pkiIssuers.indigoTelemetryClient.ttlHours)
  assert.equal(spec.target.name, "telemetry-client-tls")
  assert.equal(spec.target.creationPolicy, "Owner")
  assert.equal(spec.target.deletionPolicy, "Retain")
  assert.equal(spec.target.template.engineVersion, "v2")
  assert.equal(spec.target.template.type, "kubernetes.io/tls")
  assert.equal(spec.target.template.metadata.labels["platform.dsqr.dev/cluster"], "indigo")
  assert.deepEqual(spec.target.template.data, {
    "tls.crt": "{{ .certificate }}\n{{ .issuing_ca }}\n",
    "tls.key": "{{ .private_key }}\n",
  })
  assert.deepEqual(spec.dataFrom, [{ sourceRef: { generatorRef: {
    apiVersion: "generators.external-secrets.io/v1alpha1", kind: "VaultDynamicSecret", name: "telemetry-client-tls",
  } } }])
  const ca = resource("ConfigMap", "dsqr-home-root-ca", "observability")
  const common = render("gitops/components/external-secrets-config/common").find(r => r.kind === "ConfigMap")
  assert.equal(ca.data["ca.crt"], common.data["ca.crt"])
  assert.equal(new X509Certificate(ca.data["ca.crt"]).ca, true)
  for (const [kind, name, wave] of [["ServiceAccount", "telemetry-client-issuer", "0"],
    ["ConfigMap", "dsqr-home-root-ca", "0"], ["VaultDynamicSecret", "telemetry-client-tls", "2"],
    ["ExternalSecret", "telemetry-client-tls", "3"]]) {
    assert.equal(resource(kind, name, "observability").metadata.annotations["argocd.argoproj.io/sync-wave"], wave)
  }
})

test("observability starts restricted, deletion-protected and default-deny in both directions", () => {
  const ns = foundation.find(r => r.kind === "Namespace" && r.metadata.name === "observability")
  for (const mode of ["enforce", "warn", "audit"]) {
    assert.equal(ns.metadata.labels[`pod-security.kubernetes.io/${mode}`], "restricted")
    assert.equal(ns.metadata.labels[`pod-security.kubernetes.io/${mode}-version`], "v1.36")
  }
  assert.match(ns.metadata.annotations["argocd.argoproj.io/sync-options"], /Prune=confirm,Delete=confirm/)
  const policies = foundation.filter(r => r.kind === "NetworkPolicy" && r.metadata.namespace === "observability")
  assert.equal(policies.length, 1)
  assert.deepEqual(policies[0].spec, { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] })
  assert.equal(secrets.some(r => r.kind === "Namespace" && r.metadata.name === "observability"), false)
  assert.equal(secrets.some(r => ["Deployment", "DaemonSet", "StatefulSet", "Pod", "Job"].includes(r.kind) &&
    r.metadata.namespace === "observability"), false)
  const bootstrap = render("gitops/clusters/indigo/bootstrap").find(r => r.kind === "AppProject" && r.metadata.name === "bootstrap")
  assert.ok(bootstrap.spec.destinations.some((d: { namespace: string }) => d.namespace === "observability"))
  assert.ok(bootstrap.spec.clusterResourceWhitelist.some((r: { kind: string; name: string }) =>
    r.kind === "Namespace" && r.name === "observability"))
  assert.ok(bootstrap.spec.namespaceResourceWhitelist.some((r: { group: string; kind: string }) =>
    r.group === "networking.k8s.io" && r.kind === "NetworkPolicy"))
})

test("existing Indigo applications own telemetry credentials with explicit project permissions", () => {
  const apps = render("gitops/clusters/indigo/applications").flatMap(r => r.kind === "ApplicationSet" ? previewApplicationSet(r) : [r])
  assert.equal(apps.find(r => r.metadata.name === "external-secrets-config").spec.project, "secrets")
  assert.equal(apps.some(r => r.metadata.name === "telemetry-client-tls"), false)
  const project = render("gitops/components/argocd/overlays/indigo").find(r => r.kind === "AppProject" && r.metadata.name === "secrets")
  assert.ok(project.spec.destinations.some((d: { namespace: string }) => d.namespace === "observability"))
  assert.ok(project.spec.clusterResourceWhitelist.some((r: { kind: string; name: string }) =>
    r.kind === "ClusterRoleBinding" && r.name === "telemetry-client-issuer-auth-delegator"))
  const old = render("gitops/components/external-secrets-config/overlays/hub-a")
  assert.equal(old.some(r => ["telemetry-client-tls", "telemetry-client-issuer", "telemetry-client-issuer-auth-delegator"].includes(r.metadata.name)), false)
  assert.equal(readFileSync("gitops/components/external-secrets-config/overlays/hub-a/kustomization.yaml", "utf8").includes("client-tls"), false)
})
