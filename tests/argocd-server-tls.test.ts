import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { vault } from "../infra/vault/config.ts"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const render = (path: string) =>
  parseAllDocuments(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" }))
    .map((document) => document.toJSON())

const resources = render("gitops/components/external-secrets-config/overlays/indigo")
const resource = (kind: string, name: string, namespace?: string) => {
  const matches = resources.filter((item) => item.kind === kind && item.metadata.name === name &&
    item.metadata.namespace === namespace)
  assert.equal(matches.length, 1, `${kind}/${namespace ?? ""}/${name}`)
  return matches[0]
}

test("Argo certificate issuance is restricted to its service identity and dedicated account", () => {
  const issuer = vault.pkiIssuers.indigoArgocdServer
  const generator = resource("VaultDynamicSecret", "argocd-server-tls", "argocd").spec
  assert.deepEqual(issuer.allowedDomains, ["argocd-server.argocd.svc.cluster.local"])
  assert.equal(issuer.allowWildcardCertificates, false)
  assert.equal(issuer.generateLease, false, "short-lived login must not revoke the certificate")
  assert.equal(issuer.ttlHours, 720)
  assert.equal(issuer.maxTtlHours, 720)
  assert.equal(generator.path, `${issuer.backend}/issue/${issuer.roleName}`)
  assert.equal(generator.method, "POST")
  assert.equal(generator.resultType, "Data")
  assert.deepEqual(generator.parameters, {
    common_name: issuer.allowedDomains[0], ttl: `${issuer.ttlHours}h`,
  })
  assert.equal(generator.provider.server, "https://vault.service.home.arpa:8200")
  assert.deepEqual(generator.provider.caProvider, {
    type: "ConfigMap", name: "dsqr-home-root-ca", key: "ca.crt",
  })
  const auth = issuer.kubernetesAuthRole
  assert.deepEqual(auth.boundServiceAccountNames, ["argocd-server-issuer"])
  assert.deepEqual(auth.boundServiceAccountNamespaces, ["argocd"])
  assert.deepEqual(generator.provider.auth, { kubernetes: {
    mountPath: auth.backend, role: auth.roleName,
    serviceAccountRef: { name: auth.boundServiceAccountNames[0] },
  } })
  assert.equal(resource("ServiceAccount", "argocd-server-issuer", "argocd").automountServiceAccountToken, false)
  const binding = resource("ClusterRoleBinding", "argocd-server-issuer-auth-delegator")
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "argocd-server-issuer", namespace: "argocd" }])
  assert.deepEqual(binding.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "system:auth-delegator" })
})

test("External Secrets prepares the standard Argo TLS Secret with a renewal margin and CA chain", () => {
  const secret = resource("ExternalSecret", "argocd-server-tls", "argocd").spec
  assert.equal(secret.refreshPolicy, "Periodic")
  assert.equal(secret.refreshInterval, "240h")
  assert.ok(Number.parseInt(secret.refreshInterval) < vault.pkiIssuers.indigoArgocdServer.ttlHours)
  assert.equal(secret.target.name, "argocd-server-tls")
  assert.equal(secret.target.creationPolicy, "Owner")
  assert.equal(secret.target.deletionPolicy, "Retain")
  assert.equal(secret.target.template.type, "kubernetes.io/tls")
  assert.equal(secret.target.template.engineVersion, "v2")
  assert.equal(secret.target.template.metadata.labels["platform.dsqr.dev/cluster"], "indigo")
  assert.equal(secret.target.template.data["tls.crt"], "{{ .certificate }}\n{{ .issuing_ca }}\n")
  assert.equal(secret.target.template.data["tls.key"], "{{ .private_key }}\n")
  assert.deepEqual(secret.dataFrom, [{ sourceRef: { generatorRef: {
    apiVersion: "generators.external-secrets.io/v1alpha1", kind: "VaultDynamicSecret", name: "argocd-server-tls",
  } } }])
  assert.deepEqual(resource("ConfigMap", "dsqr-home-root-ca", "argocd").data,
    resource("ConfigMap", "dsqr-home-root-ca", "external-secrets").data)
  assert.equal(resources.some((item) => item.kind === "Secret" && item.metadata.name === "argocd-server-tls"), false)
})

test("existing generated secrets Application owns certificate preparation with scoped project access", () => {
  const applications = render("gitops/clusters/indigo/applications")
    .flatMap((item) => item.kind === "ApplicationSet" ? previewApplicationSet(item) : [item])
  const app = applications.find((item) => item.metadata.name === "external-secrets-config")
  assert.equal(app.spec.project, "secrets")
  assert.equal(app.spec.source.path, "gitops/components/external-secrets-config/overlays/indigo")
  assert.equal(applications.some((item) => item.metadata.name === "argocd-server-tls"), false)
  const project = render("gitops/components/argocd/overlays/indigo")
    .find((item) => item.kind === "AppProject" && item.metadata.name === "secrets")
  assert.ok(project.spec.destinations.some((item: { namespace: string }) => item.namespace === "argocd"))
  assert.deepEqual(project.spec.clusterResourceWhitelist.filter((item: { kind: string }) => item.kind === "ClusterRoleBinding"), [
    { group: "rbac.authorization.k8s.io", kind: "ClusterRoleBinding", name: "gateway-origin-issuer-auth-delegator" },
    { group: "rbac.authorization.k8s.io", kind: "ClusterRoleBinding", name: "argocd-server-issuer-auth-delegator" },
  ])
})

test("certificate preparation leaves routing, server mode and hub-a untouched", () => {
  const values = parse(readFileSync("gitops/components/argocd/base/values-common.yaml", "utf8"))
  assert.equal(values.configs.params["server.insecure"], "true")
  const routes = render("gitops/components/argocd/access/overlays/indigo").filter((item) => item.kind === "HTTPRoute")
  assert.equal(routes.length, 2)
  for (const route of routes) {
    for (const rule of route.spec.rules) {
      assert.deepEqual(rule.backendRefs.map((backend: { name: string; port: number }) => [backend.name, backend.port]), [["argocd-server", 80]])
    }
  }
  assert.equal(render("gitops/components/external-secrets-config/overlays/hub-a")
    .some((item) => ["argocd-server-tls", "argocd-server-issuer"].includes(item.metadata.name)), false)
})
