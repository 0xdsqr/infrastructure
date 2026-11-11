import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { parseAllDocuments } from "yaml"

const render = (path: string) =>
  parseAllDocuments(
    execFileSync("kubectl", ["kustomize", path], {
      encoding: "utf8",
    }),
  )
    .map((document) => document.toJSON())
    .filter(Boolean)

test("only Indigo admits Dotdev routes to its shared Gateway", () => {
  const namespaces = render("gitops/components/cluster-foundation/overlays/indigo")
  const namespace = namespaces.find(
    (resource) => resource.kind === "Namespace" && resource.metadata.name === "dsqr",
  )
  assert.equal(namespace.metadata.labels["platform.dsqr.dev/gateway-access"], "shared")
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted")
  for (const cluster of ["indigo", "base"]) {
    const resources = render(
      cluster === "base"
        ? "gitops/components/argocd/base"
        : "gitops/components/argocd/overlays/indigo",
    )
    const project = resources.find(
      (resource) => resource.kind === "AppProject" && resource.metadata.name === "dsqr",
    )
    assert.equal(
      project.spec.namespaceResourceWhitelist.some(
        (entry: { group: string; kind: string }) =>
          entry.group === "gateway.networking.k8s.io" && entry.kind === "HTTPRoute",
      ),
      cluster === "indigo",
    )
    assert.deepEqual(project.spec.destinations, [
      { server: "https://kubernetes.default.svc", namespace: "dsqr" },
    ])
  }
})

test("Envoy can reach only the exact Dotdev workload and application port", () => {
  const resources = render("gitops/components/gateway/overlays/indigo")
  const policy = resources.find(
    (resource) => resource.metadata.name === "envoy-shared-to-dotdev-web",
  )
  assert.equal(policy.metadata.namespace, "envoy-gateway-system")
  assert.deepEqual(policy.spec.endpointSelector.matchLabels, {
    "gateway.envoyproxy.io/owning-gateway-name": "shared",
    "gateway.envoyproxy.io/owning-gateway-namespace": "gateway-system",
  })
  assert.equal(policy.spec.ingress, undefined)
  assert.deepEqual(policy.spec.egress, [
    {
      toEndpoints: [
        {
          matchLabels: {
            "k8s:io.kubernetes.pod.namespace": "dsqr",
            "k8s:io.cilium.k8s.policy.serviceaccount": "dotdev-web",
            "app.kubernetes.io/instance": "dotdev-web",
            "app.kubernetes.io/name": "dsqr-app",
          },
        },
      ],
      toPorts: [{ ports: [{ port: "3000", protocol: "TCP" }] }],
    },
  ])
})
