import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { X509Certificate } from "node:crypto"
import test from "node:test"
import { parse, parseAllDocuments, stringify } from "yaml"
import { vault } from "../infra/vault/config.ts"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const decode = (text: string) => parseAllDocuments(text).map(d => d.toJSON()).filter(Boolean)
const kustomize = (path: string) => decode(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" }))
const declarations = kustomize("gitops/components/external-secrets-config/overlays/indigo")
const secretName = "metrics-server-serving-tls"
const get = (kind: string, name: string, namespace?: string) => {
  const matches = declarations.filter(o => o.kind === kind && o.metadata.name === name && o.metadata.namespace === namespace)
  assert.equal(matches.length, 1, `${kind}/${namespace ?? ""}/${name}`)
  return matches[0]
}
const prepared = parse(readFileSync("gitops/components/metrics-server/serving-tls/values-provided.yaml", "utf8"))

test("Metrics Server issuer is restricted to its exact service DNS names and separate identity", () => {
  const issuer = vault.pkiIssuers.indigoMetricsServer
  assert.equal(issuer.backend, "pki_int")
  assert.deepEqual(issuer.allowedDomains, ["metrics-server.kube-system.svc", "metrics-server.kube-system.svc.cluster.local"])
  assert.equal(issuer.allowWildcardCertificates, false)
  assert.equal(issuer.generateLease, false)
  assert.equal(issuer.ttlHours, 720)
  assert.equal(issuer.maxTtlHours, 720)
  const generator = get("VaultDynamicSecret", secretName, "kube-system").spec
  assert.equal(generator.path, `${issuer.backend}/issue/${issuer.roleName}`)
  assert.equal(generator.method, "POST")
  assert.equal(generator.resultType, "Data")
  assert.deepEqual(generator.parameters, {
    common_name: issuer.allowedDomains[0], alt_names: issuer.allowedDomains[1], ttl: "720h",
  })
  assert.equal(generator.provider.server, "https://vault.service.home.arpa:8200")
  assert.deepEqual(generator.provider.caProvider, { type: "ConfigMap", name: "dsqr-home-root-ca", key: "ca.crt" })
  assert.equal(new X509Certificate(get("ConfigMap", "dsqr-home-root-ca", "kube-system").data["ca.crt"]).ca, true)
  assert.deepEqual(issuer.kubernetesAuthRole.boundServiceAccountNames, ["metrics-server-issuer"])
  assert.deepEqual(issuer.kubernetesAuthRole.boundServiceAccountNamespaces, ["kube-system"])
  assert.deepEqual(generator.provider.auth.kubernetes, {
    mountPath: issuer.kubernetesAuthRole.backend, role: issuer.kubernetesAuthRole.roleName,
    serviceAccountRef: { name: "metrics-server-issuer" },
  })
  assert.equal(get("ServiceAccount", "metrics-server-issuer", "kube-system").automountServiceAccountToken, false)
  const binding = get("ClusterRoleBinding", "metrics-server-issuer-auth-delegator")
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "metrics-server-issuer", namespace: "kube-system" }])
  assert.deepEqual(binding.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "system:auth-delegator" })
})

test("ESO renews early and retains the certificate without declaring private material in Git", () => {
  const es = get("ExternalSecret", secretName, "kube-system").spec
  assert.equal(es.refreshPolicy, "Periodic")
  assert.equal(es.refreshInterval, "240h")
  assert.equal(es.target.name, secretName)
  assert.equal(es.target.creationPolicy, "Owner")
  assert.equal(es.target.deletionPolicy, "Retain")
  assert.equal(es.target.template.engineVersion, "v2")
  assert.equal(es.target.template.type, "kubernetes.io/tls")
  assert.equal(es.target.template.metadata.labels["platform.dsqr.dev/cluster"], "indigo")
  assert.deepEqual(es.target.template.data, {
    "tls.crt": "{{ .certificate }}\n{{ .issuing_ca }}\n", "tls.key": "{{ .private_key }}\n", "ca.crt": "{{ .issuing_ca }}\n",
  })
  assert.deepEqual(es.dataFrom, [{ sourceRef: { generatorRef: {
    apiVersion: "generators.external-secrets.io/v1alpha1", kind: "VaultDynamicSecret", name: secretName,
  } } }])
  assert.equal(declarations.some(o => o.kind === "Secret" && o.metadata.name === secretName), false)
  // Metrics Server has native certificate reload; no new kube-system Reloader.
  assert.equal(es.target.template.metadata.labels["platform.dsqr.dev/tls-reload"], undefined)
})

test("issuance uses existing generated ownership, leaves chart cutover manual and does not touch hub-a", () => {
  const apps = kustomize("gitops/clusters/indigo/applications")
    .flatMap(o => o.kind === "ApplicationSet" ? previewApplicationSet(o) : [o])
  assert.equal(apps.some(o => /metrics.*tls/.test(o.metadata.name)), false)
  assert.equal(apps.find(o => o.metadata.name === "external-secrets-config").spec.source.path,
    "gitops/components/external-secrets-config/overlays/indigo")
  const metrics = apps.find(o => o.metadata.name === "metrics-server")
  assert.equal(metrics.spec.syncPolicy.automated.enabled, false)
  assert.equal(JSON.stringify(metrics).includes("values-provided.yaml"), false)
  const active = parse(readFileSync("gitops/components/metrics-server/overlays/indigo/values-overrides.yaml", "utf8"))
  assert.equal(active.tls, undefined)
  assert.equal(active.apiService, undefined)
  const project = kustomize("gitops/components/argocd/overlays/indigo").find(o => o.kind === "AppProject" && o.metadata.name === "secrets").spec
  assert.ok(project.destinations.some((o: any) => o.namespace === "kube-system"))
  assert.ok(project.clusterResourceWhitelist.some((o: any) => o.kind === "ClusterRoleBinding" && o.name === "metrics-server-issuer-auth-delegator"))
  assert.equal(kustomize("gitops/components/external-secrets-config/overlays/hub-a").some(o => /metrics-server/.test(o.metadata.name)), false)
})

test("pinned chart supports deterministic directory-mounted certificates and explicit API trust", {
  skip: !process.env.METRICS_SERVER_TEST_CHART,
}, () => {
  assert.deepEqual(prepared.tls, { type: "existingSecret", existingSecret: { name: secretName, lookup: false } })
  const ca = get("ConfigMap", "dsqr-home-root-ca", "kube-system").data["ca.crt"]
  // Exercise the future verified cutover offline, not in the active values.
  const args = ["template", "metrics-server", process.env.METRICS_SERVER_TEST_CHART!, "--namespace", "kube-system",
    "-f", "gitops/components/metrics-server/base/values-common.yaml",
    "-f", "gitops/components/metrics-server/overlays/indigo/values-overrides.yaml", "-f", "-"]
  const input = stringify({ ...prepared, apiService: { insecureSkipTLSVerify: false, caBundle: ca } })
  const rendered = execFileSync("helm", args, { encoding: "utf8", input })
  assert.equal(execFileSync("helm", args, { encoding: "utf8", input }), rendered)
  const resources = decode(rendered)
  assert.equal(resources.some(o => o.kind === "Secret"), false)
  const api = resources.find(o => o.kind === "APIService").spec
  assert.notEqual(api.insecureSkipTLSVerify, true)
  assert.equal(Buffer.from(api.caBundle, "base64").toString(), ca)
  const deploy = resources.find(o => o.kind === "Deployment")
  assert.equal(deploy.spec.replicas, 2)
  assert.equal(deploy.spec.strategy.rollingUpdate.maxUnavailable, 0)
  const pod = deploy.spec.template.spec
  const container = pod.containers[0]
  assert.ok(container.args.includes("--tls-cert-file=/tmp/tls-certs/tls.crt"))
  assert.ok(container.args.includes("--tls-private-key-file=/tmp/tls-certs/tls.key"))
  assert.ok(container.args.includes("--kubelet-certificate-authority=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"))
  assert.equal(container.args.includes("--kubelet-insecure-tls"), false)
  assert.deepEqual(pod.volumes.find((o: any) => o.name === "certs").secret, { secretName })
  assert.deepEqual(container.volumeMounts.find((o: any) => o.name === "certs"), { mountPath: "/tmp/tls-certs", name: "certs", readOnly: true })
})
