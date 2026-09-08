import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { parseAllDocuments } from "yaml"

const render = (path: string) =>
  parseAllDocuments(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" })).map(
    (document) => document.toJSON(),
  )
const gateway = () => render("gitops/components/gateway/overlays/indigo")
const argo = () => render("gitops/components/argocd/access/overlays/indigo")
const ports = (rules: any[]) =>
  rules.flatMap((rule) =>
    rule.toPorts.flatMap((entry: any) => entry.ports.map((port: any) => port.port)),
  )

test("Envoy allow rules stage without enabling default-deny prematurely", () => {
  const deny = gateway().find((resource) => resource.kind === "NetworkPolicy")
  assert.equal(deny.metadata.name, "envoy-gateway-default-deny")
  assert.equal(deny.metadata.namespace, "envoy-gateway-system")
  assert.deepEqual(deny.spec.podSelector, {})
  assert.deepEqual(deny.spec.policyTypes, ["Ingress", "Egress"])
  assert.equal(deny.metadata.annotations["argocd.argoproj.io/sync-wave"], "1")
  const policies = [...gateway(), ...argo()].filter(
    (resource) =>
      resource.kind === "CiliumNetworkPolicy" &&
      resource.metadata.namespace === "envoy-gateway-system",
  )
  assert.equal(policies.length, 4)
  for (const policy of policies) {
    assert.equal(policy.metadata.annotations["argocd.argoproj.io/sync-wave"], "0")
    assert.deepEqual(policy.spec.enableDefaultDeny, { ingress: false, egress: false })
    assert.notDeepEqual(policy.spec.endpointSelector, {})
    for (const rule of [...(policy.spec.ingress ?? []), ...(policy.spec.egress ?? [])]) {
      assert.ok(rule.toPorts.length > 0)
      assert.ok(
        rule.fromEndpoints ||
          rule.toEndpoints ||
          rule.fromEntities ||
          rule.toEntities ||
          rule.fromCIDR,
      )
      assert.ok(
        ![...(rule.fromEntities ?? []), ...(rule.toEntities ?? [])].some((entity) =>
          ["world", "cluster", "all"].includes(entity),
        ),
      )
    }
  }
})

test("only the DMZ host reaches shared HTTPS; no unused Envoy services are allowed", () => {
  const resources = gateway()
  const proxyConfig = resources.find((resource) => resource.kind === "EnvoyProxy")
  assert.equal(proxyConfig.spec.provider.kubernetes.envoyService.externalTrafficPolicy, "Local")
  assert.equal(proxyConfig.metadata.labels["platform.dsqr.dev/tier"], "platform-addon")
  const dmz = resources.find((resource) => resource.metadata.name === "envoy-shared-dmz-ingress")
  assert.deepEqual(dmz.spec.ingress, [
    { fromCIDR: ["10.10.60.100/32"], toPorts: [{ ports: [{ port: "10443", protocol: "TCP" }] }] },
  ])
  const controller = resources.find(
    (resource) => resource.metadata.name === "envoy-gateway-controller-access",
  ).spec
  assert.deepEqual(ports(controller.ingress), ["18000", "9443", "8081", "19001"])
  assert.deepEqual(controller.ingress[0].fromEndpoints[0].matchLabels, {
    "k8s:io.kubernetes.pod.namespace": "envoy-gateway-system",
    "gateway.envoyproxy.io/owning-gateway-name": "shared",
    "gateway.envoyproxy.io/owning-gateway-namespace": "gateway-system",
  })
  assert.deepEqual(ports(controller.egress), ["6443", "53", "53"])
  assert.deepEqual(controller.egress[0].toEntities, ["kube-apiserver"])
  const proxy = resources.find(
    (resource) => resource.metadata.name === "envoy-shared-proxy-access",
  ).spec
  assert.deepEqual(ports(proxy.ingress), ["19002", "19003", "19001"])
  assert.deepEqual(ports(proxy.egress), ["18000", "53", "53"])
  assert.equal(proxy.egress[0].toEndpoints[0].matchLabels["control-plane"], "envoy-gateway")
  for (const spec of [controller, proxy]) {
    assert.deepEqual(spec.egress[1].toEndpoints[0].matchLabels, {
      "k8s:io.kubernetes.pod.namespace": "kube-system",
      "k8s:k8s-app": "kube-dns",
    })
    assert.deepEqual(spec.egress[1].toPorts[0].ports, [
      { port: "53", protocol: "UDP" },
      { port: "53", protocol: "TCP" },
    ])
  }
})

test("backend access belongs to the Argo route component, not blanket gateway egress", () => {
  const policy = argo().find((resource) => resource.metadata.name === "envoy-shared-to-argocd")
  assert.deepEqual(policy.spec.egress, [
    {
      toEndpoints: [
        {
          matchLabels: {
            "k8s:io.kubernetes.pod.namespace": "argocd",
            "app.kubernetes.io/instance": "argocd",
            "app.kubernetes.io/name": "argocd-server",
          },
        },
      ],
      toPorts: [{ ports: [{ port: "8080", protocol: "TCP" }] }],
    },
  ])
  assert.ok(!gateway().some((resource) => resource.metadata.name === "envoy-shared-to-argocd"))
  const projects = render("gitops/components/argocd/overlays/indigo")
  for (const name of ["platform-gateway", "platform-argocd-access"]) {
    const project = projects.find(
      (resource) => resource.kind === "AppProject" && resource.metadata.name === name,
    )
    assert.ok(
      project.spec.destinations.some(
        (destination: any) => destination.namespace === "envoy-gateway-system",
      ),
    )
    assert.ok(
      project.spec.namespaceResourceWhitelist.some(
        (permission: any) =>
          permission.group === "cilium.io" && permission.kind === "CiliumNetworkPolicy",
      ),
    )
  }
})
