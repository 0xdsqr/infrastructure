import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { X509Certificate } from "node:crypto"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { vault } from "../infra/vault/config.ts"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const render = (path: string) => parseAllDocuments(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" }))
  .map(document => document.toJSON())
const declarations = render("gitops/components/external-secrets-config/overlays/indigo")
const get = (kind: string, name: string, namespace?: string) => {
  const matches = declarations.filter(item => item.kind === kind && item.metadata.name === name && item.metadata.namespace === namespace)
  assert.equal(matches.length, 1, `${kind}/${namespace ?? ""}/${name}`)
  return matches[0]
}

test("Hubble uses a dedicated Vault trust domain and server-only scoped identity", () => {
  const issuer = vault.pkiIssuers.indigoHubbleServer
  assert.equal(issuer.backend, "pki_indigo_hubble")
  assert.ok(issuer.managedCa.ttlHours > issuer.maxTtlHours)
  assert.deepEqual(issuer.allowedDomains, ["*.indigo.hubble-grpc.cilium.io"])
  assert.equal(issuer.allowWildcardCertificates, true)
  assert.equal(issuer.generateLease, false)
  const generator = get("VaultDynamicSecret", "dsqr-hubble-server-tls", "kube-system").spec
  assert.equal(generator.path, `${issuer.backend}/issue/${issuer.roleName}`)
  assert.equal(generator.method, "POST")
  assert.equal(generator.resultType, "Data")
  assert.deepEqual(generator.parameters, { common_name: issuer.allowedDomains[0], ttl: "720h" })
  assert.equal(generator.provider.server, "https://vault.service.home.arpa:8200")
  assert.deepEqual(generator.provider.caProvider, { type: "ConfigMap", name: "dsqr-home-root-ca", key: "ca.crt" })
  assert.ok(get("ConfigMap", "dsqr-home-root-ca", "kube-system").data["ca.crt"].startsWith("-----BEGIN CERTIFICATE-----"))
  assert.deepEqual(generator.provider.auth.kubernetes, {
    mountPath: issuer.kubernetesAuthRole.backend,
    role: issuer.kubernetesAuthRole.roleName,
    serviceAccountRef: { name: "hubble-server-issuer" },
  })
  assert.deepEqual(issuer.kubernetesAuthRole.boundServiceAccountNames, ["hubble-server-issuer"])
  assert.deepEqual(issuer.kubernetesAuthRole.boundServiceAccountNamespaces, ["kube-system"])
  assert.equal(get("ServiceAccount", "hubble-server-issuer", "kube-system").automountServiceAccountToken, false)
  const binding = get("ClusterRoleBinding", "hubble-server-issuer-auth-delegator")
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "hubble-server-issuer", namespace: "kube-system" }])
  assert.deepEqual(binding.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "system:auth-delegator" })
})

test("Hubble issuance prepares a separate automatically renewed Secret without changing live ownership", () => {
  const es = get("ExternalSecret", "dsqr-hubble-server-tls", "kube-system").spec
  assert.equal(es.refreshPolicy, "Periodic")
  assert.equal(es.refreshInterval, "240h")
  assert.equal(es.target.name, "dsqr-hubble-server-tls")
  assert.equal(es.target.creationPolicy, "Owner")
  assert.equal(es.target.deletionPolicy, "Retain")
  assert.equal(es.target.template.type, "kubernetes.io/tls")
  assert.deepEqual(es.target.template.data, {
    "tls.crt": "{{ .certificate }}\n{{ .issuing_ca }}\n",
    "tls.key": "{{ .private_key }}\n",
    "ca.crt": "{{ .issuing_ca }}\n",
  })
  assert.deepEqual(es.dataFrom, [{ sourceRef: { generatorRef: {
    apiVersion: "generators.external-secrets.io/v1alpha1", kind: "VaultDynamicSecret", name: "dsqr-hubble-server-tls",
  } } }])
  assert.equal(es.target.template.metadata.labels["platform.dsqr.dev/cluster"], "indigo")
  assert.equal(declarations.some(item => item.kind === "Secret" && /hubble|cilium/.test(item.metadata.name)), false)
  assert.equal(declarations.some(item => item.kind === "ExternalSecret" && ["cilium-ca", "hubble-server-certs"].includes(item.spec.target.name)), false)
})

test("Hubble preparation stays Indigo-only with no new Application or active Cilium cutover", () => {
  const apps = render("gitops/clusters/indigo/applications")
    .flatMap(item => item.kind === "ApplicationSet" ? previewApplicationSet(item) : [item])
  assert.equal(apps.some(item => /hubble/.test(item.metadata.name)), false)
  assert.equal(apps.find(item => item.metadata.name === "external-secrets-config").spec.source.path,
    "gitops/components/external-secrets-config/overlays/indigo")
  const cilium = apps.find(item => item.metadata.name === "cilium")
  assert.equal(JSON.stringify(cilium).includes("values-provided.yaml"), false)
  const active = parse(readFileSync("gitops/components/cilium/overlays/indigo/values-overrides.yaml", "utf8"))
  assert.deepEqual(active.hubble.tls, {
    enabled: true, auto: { enabled: false }, server: { existingSecret: "hubble-server-certs" },
  })
  assert.equal(cilium.spec.syncPolicy.automated.enabled, false)
  assert.equal(cilium.spec.syncPolicy.automated.prune, false)
  const prepared = parse(readFileSync("gitops/components/cilium/hubble-tls/values-provided.yaml", "utf8"))
  assert.equal(prepared.hubble.tls.auto.enabled, false)
  assert.equal(prepared.hubble.tls.server.existingSecret, "dsqr-hubble-server-tls")
  const project = render("gitops/components/argocd/overlays/indigo")
    .find(item => item.kind === "AppProject" && item.metadata.name === "secrets").spec
  assert.ok(project.destinations.some((item: { namespace: string }) => item.namespace === "kube-system"))
  assert.ok(project.clusterResourceWhitelist.some((item: { name: string; kind: string }) => item.kind === "ClusterRoleBinding" && item.name === "hubble-server-issuer-auth-delegator"))
  assert.equal(render("gitops/components/external-secrets-config/overlays/hub-a")
    .some(item => /hubble/.test(item.metadata.name)), false)
})

test("trust stage pins exactly the old and new public CAs without switching the serving identity", () => {
  const active = parse(readFileSync("gitops/components/cilium/overlays/indigo/values-overrides.yaml", "utf8"))
  const bundle = active.tls.caBundle
  assert.equal(bundle.enabled, true)
  assert.equal(bundle.name, "dsqr-hubble-ca-bundle")
  assert.equal(bundle.key, "ca.crt")
  assert.equal(bundle.useSecret, false)
  assert.doesNotMatch(bundle.content, /PRIVATE KEY/)
  const certificates = [...bundle.content.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)]
    .map(match => new X509Certificate(match[0]))
  assert.deepEqual(certificates.map(cert => cert.fingerprint256), [
    "ED:0F:56:69:EF:2A:BA:3D:D0:48:0B:62:A5:56:43:A1:00:F8:0A:AB:C0:8C:3F:7E:DD:3E:E8:C1:FF:94:F2:BB",
    "62:05:DB:A2:1C:4A:AA:53:F3:74:61:8D:F4:02:1B:67:04:38:19:B3:B6:47:6E:56:B0:73:AE:D6:E6:C2:B8:B0",
  ])
  for (const cert of certificates) {
    assert.equal(cert.ca, true)
    assert.equal(cert.verify(cert.publicKey), true)
  }
  assert.equal(active.hubble.tls.server.existingSecret, "hubble-server-certs")
  assert.equal(active.updateStrategy.rollingUpdate.maxUnavailable, 1)
  const hubA = parse(readFileSync("gitops/components/cilium/overlays/hub-a/values-overrides.yaml", "utf8"))
  assert.equal(hubA.tls?.caBundle, undefined)
})

test("pinned Cilium trust-stage render keeps the old Secret and mounts the dual-CA ConfigMap", {
  skip: !process.env.HUBBLE_CILIUM_CHART,
}, () => {
  const args = ["template", "cilium", process.env.HUBBLE_CILIUM_CHART!, "--namespace", "kube-system",
    "-f", "gitops/components/cilium/base/values-common.yaml",
    "-f", "gitops/components/cilium/overlays/indigo/values-overrides.yaml"]
  const first = execFileSync("helm", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  assert.equal(execFileSync("helm", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }), first)
  const rendered = parseAllDocuments(first).map(document => document.toJSON()).filter(Boolean)
  assert.equal(rendered.some(item => item.kind === "Secret"), false)
  const cm = rendered.find(item => item.kind === "ConfigMap" && item.metadata.name === "dsqr-hubble-ca-bundle")
  assert.equal(cm.metadata.namespace, "kube-system")
  assert.equal((cm.data["ca.crt"].match(/BEGIN CERTIFICATE/g) ?? []).length, 2)
  const agent = rendered.find(item => item.kind === "DaemonSet" && item.metadata.name === "cilium")
  assert.equal(agent.spec.updateStrategy.rollingUpdate.maxUnavailable, 1)
  const volume = agent.spec.template.spec.volumes.find((item: { name: string }) => item.name === "hubble-tls")
  assert.equal(volume.projected.sources[0].secret.name, "hubble-server-certs")
  assert.deepEqual(volume.projected.sources[0].secret.items, [
    { key: "tls.crt", path: "server.crt" }, { key: "tls.key", path: "server.key" },
  ])
  assert.equal(volume.projected.sources[1].configMap.name, "dsqr-hubble-ca-bundle")
  assert.deepEqual(volume.projected.sources[1].configMap.items, [{ key: "ca.crt", path: "client-ca.crt" }])
})

test("pinned Cilium chart consumes the prepared Secret without generating signing keys", {
  skip: !process.env.HUBBLE_CILIUM_CHART,
}, () => {
  const chart = process.env.HUBBLE_CILIUM_CHART!
  const metadata = parse(execFileSync("helm", ["show", "chart", chart], { encoding: "utf8" }))
  assert.equal(metadata.version, "1.20.1")
  const args = ["template", "cilium", chart, "--namespace", "kube-system",
    "-f", "gitops/components/cilium/base/values-common.yaml",
    "-f", "gitops/components/cilium/overlays/indigo/values-overrides.yaml",
    "-f", "gitops/components/cilium/hubble-tls/values-provided.yaml"]
  const first = execFileSync("helm", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  assert.equal(execFileSync("helm", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }), first)
  const rendered = parseAllDocuments(first).map(document => document.toJSON()).filter(Boolean)
  assert.equal(rendered.some(item => item.kind === "Secret"), false)
  const agent = rendered.find(item => item.kind === "DaemonSet" && item.metadata.name === "cilium")
  const projected = agent.spec.template.spec.volumes.flatMap((volume: { projected?: { sources: object[] } }) => volume.projected?.sources ?? [])
  assert.ok(projected.some((source: { secret?: { name: string } }) => source.secret?.name === "dsqr-hubble-server-tls"))
  assert.equal(projected.some((source: { secret?: { name: string } }) => source.secret?.name === "hubble-server-certs"), false)
  assert.equal(agent.spec.updateStrategy.rollingUpdate.maxUnavailable, 1)
})
