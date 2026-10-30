import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { vault } from "../infra/vault/config.ts"
import { cloudflare, indigoIngressRules } from "../infra/cloudflare/config.ts"

const render = (component: string) => parseAllDocuments(execFileSync("kubectl", [
  "kustomize", `gitops/components/${component}/overlays/indigo`,
], { encoding: "utf8" })).map(document => document.toJSON())

test("Indigo tunnel is HA, restricted, and exclusively scheduled on platform nodes", () => {
  const resources = render("cloudflared")
  const deployment = resources.find(resource => resource.kind === "Deployment")
  const spec = deployment.spec.template.spec
  assert.equal(deployment.spec.replicas, 2)
  assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0)
  assert.equal(spec.nodeSelector["platform.dsqr.dev/node-pool"], "platform")
  assert.deepEqual(spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values, ["platform"])
  assert.equal(spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey, "kubernetes.io/hostname")
  assert.deepEqual(spec.tolerations, [{ key: "platform.dsqr.dev/dedicated", operator: "Equal", value: "platform", effect: "NoSchedule" }])
  assert.equal(spec.automountServiceAccountToken, false)
  assert.equal(spec.securityContext.runAsNonRoot, true)
  const container = spec.containers[0]
  assert.match(container.image, /@sha256:[a-f0-9]{64}$/)
  assert.equal(container.securityContext.readOnlyRootFilesystem, true)
  assert.equal(container.securityContext.allowPrivilegeEscalation, false)
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"])
  assert.equal(container.env, undefined)
  assert.ok(container.args.includes("--token-file"))
  assert.equal(container.readinessProbe.httpGet.path, "/ready")
  assert.equal(resources.find(resource => resource.kind === "PodDisruptionBudget").spec.minAvailable, 1)
  assert.equal(resources.some(resource => ["Secret", "Service", "ClusterRole", "Role"].includes(resource.kind)), false)
  const deny = resources.find(resource => resource.kind === "NetworkPolicy")
  assert.deepEqual(deny.spec.podSelector, {})
  assert.deepEqual(deny.spec.policyTypes, ["Ingress", "Egress"])
  const allow = resources.find(resource => resource.kind === "CiliumNetworkPolicy")
  assert.equal(allow.spec.egress.length, 3)
  assert.deepEqual(allow.spec.egress[1].toPorts[0].ports, [{ port: "7844", protocol: "UDP" }, { port: "7844", protocol: "TCP" }])
})

test("Only Dotdev Web uses the TLS-verified Indigo origin", () => {
  const resources = render("cloudflared")
  const ca = resources.find(resource => resource.kind === "ConfigMap" && resource.metadata.name === "dsqr-home-root-ca")
  const issuerCa = render("external-secrets-config").find(resource => resource.kind === "ConfigMap" && resource.metadata.name === "dsqr-home-root-ca" && resource.metadata.namespace === "gateway-system")
  assert.deepEqual(ca.data, issuerCa.data)
  const tunnel = resources.find(resource => resource.kind === "Deployment" && resource.metadata.name === "cloudflared")
  const mount = tunnel.spec.template.spec.containers[0].volumeMounts.find((item: {name: string}) => item.name === "origin-ca")
  assert.equal(mount.readOnly, true)
  assert.equal(mount.mountPath, "/etc/cloudflared-ca")
  assert.deepEqual(indigoIngressRules, ["dsqr.dev"].map(hostname => ({
    hostname,
    zone: "dsqrDev",
    service: "https://envoy-gateway-system-shared-e9cec0f8.envoy-gateway-system.svc.cluster.local:443",
    originRequest: {
      httpHostHeader: hostname,
      originServerName: "gateway.indigo.home.arpa",
      caPool: "/etc/cloudflared-ca/ca.crt",
    },
  })))
  assert.equal(cloudflare.ingressRules.some(rule => rule.hostname === "dsqr.dev"), false)
  for (const hostname of ["labs.dsqr.dev", "studio.dsqr.dev", "tastingswithtay.com"]) {
    assert.ok(cloudflare.ingressRules.some(rule => rule.hostname === hostname))
  }
  assert.equal(cloudflare.ingressRules.some(rule => rule.hostname === "dotdev-preview.dsqr.dev"), false)
  assert.equal(resources.some(resource => resource.kind === "HTTPRoute" || resource.metadata.name === "ingress-canary"), false)
  assert.equal(render("gateway").some(resource => resource.metadata.name === "envoy-shared-to-ingress-canary"), false)
})

test("Tunnel token is single-path Vault access, with no account credential in GitOps", () => {
  const bootstrap = parse(readFileSync("gitops/clusters/indigo/bootstrap/bootstrap.appproject.yaml", "utf8"))
  assert.ok(bootstrap.spec.clusterResourceWhitelist.some((resource: {kind: string; name: string}) => resource.kind === "Namespace" && resource.name === "cloudflare-system"))
  const secret = render("external-secrets-config").find(resource => resource.kind === "ExternalSecret" && resource.metadata.name === "cloudflared-token")
  assert.equal(secret.metadata.namespace, "cloudflare-system")
  assert.equal(secret.spec.secretStoreRef.name, "vault-indigo")
  assert.deepEqual(secret.spec.data, [{ secretKey: "token", remoteRef: { key: vault.secretPaths.indigoCloudflareTunnel.path, property: "token" } }])
  assert.deepEqual(vault.externalSecretsKubernetesAuthBoundaries.indigo.policies.cloudflareTunnel.readPaths, [vault.secretPaths.indigoCloudflareTunnel.path])
  const inventory = parse(readFileSync("gitops/components/application-set/overlays/indigo/inventory.yaml", "utf8"))
  const app = inventory.spec.generators[0].matrix.generators[1].list.elements.find((item: {name: string}) => item.name === "cloudflared")
  assert.equal(app.lifecycle, "controller")
  assert.equal(app.project, "platform-cloudflared")
  assert.deepEqual(app.charts, [])
  const project = render("argocd").find(resource => resource.kind === "AppProject" && resource.metadata.name === "platform-cloudflared")
  assert.deepEqual(project.spec.clusterResourceWhitelist, [])
  assert.equal(project.spec.namespaceResourceWhitelist.some((resource: {kind: string}) => ["Secret", "Service", "HTTPRoute"].includes(resource.kind)), false)
})

test("OPNsense tunnel egress matches the Cilium destination inventory and platform workers only", () => {
  const firewall = JSON.parse(readFileSync("infra/opnsense/indigo-tunnel-egress.json", "utf8"))
  assert.deepEqual(firewall.aliases[0].addresses, ["10.10.80.103", "10.10.80.104", "10.10.80.105"])
  const policy = render("cloudflared").find(resource => resource.kind === "CiliumNetworkPolicy")
  assert.deepEqual(firewall.aliases[1].addresses.map((address: string) => `${address}/32`).sort(), [...policy.spec.egress[1].toCIDR].sort())
  assert.equal(firewall.rule.destination_port, "7844")
  assert.equal(firewall.rule.protocol, "TCP/UDP")
  assert.equal(firewall.rule.source_net, firewall.aliases[0].name)
  assert.equal(firewall.rule.destination_net, firewall.aliases[1].name)
  assert.equal(firewall.rule.interface, "opt8")
  assert.equal(firewall.rule.direction, "in")
  assert.equal(firewall.rule.source_not, "0")
  assert.equal(firewall.rule.destination_not, "0")
})
