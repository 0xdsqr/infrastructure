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
const servingSecret = "argocd-repo-server-serving-tls"
const resource = (kind: string, name: string, namespace?: string) => {
  const matches = resources.filter((item) => item.kind === kind && item.metadata.name === name &&
    item.metadata.namespace === namespace)
  assert.equal(matches.length, 1, `${kind}/${namespace ?? ""}/${name}`)
  return matches[0]
}

test("repo-server issuance permits only its service DNS identities through a dedicated issuer", () => {
  const issuer = vault.pkiIssuers.indigoArgocdRepoServer
  const generator = resource("VaultDynamicSecret", servingSecret, "argocd").spec
  assert.deepEqual(issuer.allowedDomains, [
    "argocd-repo-server.argocd.svc.cluster.local",
    "argocd-repo-server.argocd.svc",
  ])
  assert.equal(issuer.allowWildcardCertificates, false)
  assert.equal(issuer.generateLease, false)
  assert.equal(issuer.ttlHours, 720)
  assert.equal(issuer.maxTtlHours, 720)
  assert.equal(generator.path, `${issuer.backend}/issue/${issuer.roleName}`)
  assert.equal(generator.method, "POST")
  assert.equal(generator.resultType, "Data")
  assert.deepEqual(generator.parameters, {
    common_name: issuer.allowedDomains[0],
    alt_names: issuer.allowedDomains.slice(1).join(","),
    ttl: `${issuer.ttlHours}h`,
  })
  assert.equal(generator.provider.server, "https://vault.service.home.arpa:8200")
  assert.deepEqual(generator.provider.caProvider, {
    type: "ConfigMap", name: "dsqr-home-root-ca", key: "ca.crt",
  })
  assert.ok(resource("ConfigMap", "dsqr-home-root-ca", "argocd").data["ca.crt"])
  const auth = issuer.kubernetesAuthRole
  assert.deepEqual(auth.boundServiceAccountNames, ["argocd-repo-server-issuer"])
  assert.deepEqual(auth.boundServiceAccountNamespaces, ["argocd"])
  assert.deepEqual(generator.provider.auth, { kubernetes: {
    mountPath: auth.backend, role: auth.roleName,
    serviceAccountRef: { name: auth.boundServiceAccountNames[0] },
  } })
  assert.equal(resource("ServiceAccount", "argocd-repo-server-issuer", "argocd").automountServiceAccountToken, false)
  const binding = resource("ClusterRoleBinding", "argocd-repo-server-issuer-auth-delegator")
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "argocd-repo-server-issuer", namespace: "argocd" }])
  assert.deepEqual(binding.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "system:auth-delegator" })
})

test("repo-server certificate preparation renews early without populating the chart's shared key mount", () => {
  const secret = resource("ExternalSecret", servingSecret, "argocd").spec
  assert.equal(secret.refreshPolicy, "Periodic")
  assert.equal(secret.refreshInterval, "240h")
  assert.ok(Number.parseInt(secret.refreshInterval) < vault.pkiIssuers.indigoArgocdRepoServer.ttlHours)
  assert.equal(secret.target.name, servingSecret)
  assert.equal(secret.target.creationPolicy, "Owner")
  assert.equal(secret.target.deletionPolicy, "Retain")
  assert.equal(secret.target.template.type, "kubernetes.io/tls")
  assert.equal(secret.target.template.engineVersion, "v2")
  assert.equal(secret.target.template.metadata.labels["platform.dsqr.dev/cluster"], "indigo")
  assert.deepEqual(secret.target.template.data, {
    "tls.crt": "{{ .certificate }}\n{{ .issuing_ca }}\n",
    "tls.key": "{{ .private_key }}\n",
    "ca.crt": "{{ .issuing_ca }}\n",
  })
  assert.deepEqual(secret.dataFrom, [{ sourceRef: { generatorRef: {
    apiVersion: "generators.external-secrets.io/v1alpha1", kind: "VaultDynamicSecret", name: servingSecret,
  } } }])
  assert.equal(resources.some((item) => item.kind === "Secret" && item.metadata.name === servingSecret), false)
  assert.equal(resources.some((item) => item.kind === "ExternalSecret" && item.spec.target.name === "argocd-repo-server-tls"), false)
  const values = parse(readFileSync("gitops/components/argocd/overlays/indigo/values-overrides.yaml", "utf8"))
  for (const client of ["server", "controller", "applicationsetcontroller"]) {
    assert.notEqual(values.configs.params[`${client}.repo.server.strict.tls`], "true")
  }
  assert.equal(values.repoServer.volumes[0].secret.secretName, servingSecret)
  for (const client of ["server", "controller", "applicationSet"]) {
    assert.equal(JSON.stringify(values[client]).includes(servingSecret), false)
    assert.equal((values[client].volumes ?? values[client].extraVolumes)[0].configMap.name, "dsqr-home-root-ca")
  }
  assert.equal(secret.target.template.metadata.labels["platform.dsqr.dev/tls-reload"], "true")
  assert.equal(resource("ConfigMap", "dsqr-home-root-ca", "argocd").metadata.labels["platform.dsqr.dev/tls-reload"], "true")
})

test("existing generated secrets Application owns repo-server certificate preparation only on Indigo", () => {
  const applications = render("gitops/clusters/indigo/applications")
    .flatMap((item) => item.kind === "ApplicationSet" ? previewApplicationSet(item) : [item])
  const app = applications.find((item) => item.metadata.name === "external-secrets-config")
  assert.equal(app.spec.project, "secrets")
  assert.equal(app.spec.source.path, "gitops/components/external-secrets-config/overlays/indigo")
  assert.equal(applications.some((item) => /repo.*tls/.test(item.metadata.name)), false)
  const project = render("gitops/components/argocd/overlays/indigo")
    .find((item) => item.kind === "AppProject" && item.metadata.name === "secrets")
  assert.ok(project.spec.clusterResourceWhitelist.some((item: { kind: string; name: string }) =>
    item.kind === "ClusterRoleBinding" && item.name === "argocd-repo-server-issuer-auth-delegator"))
  assert.equal(render("gitops/components/external-secrets-config/overlays/hub-a")
    .some((item) => [servingSecret, "argocd-repo-server-issuer", "argocd-repo-server-issuer-auth-delegator"].includes(item.metadata.name)), false)
})
