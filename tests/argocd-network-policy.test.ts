import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { parseAllDocuments } from "yaml"

const render = (path: string) =>
  parseAllDocuments(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" })).map(
    (document) => document.toJSON(),
  )
const indigo = () => render("gitops/components/argocd/overlays/indigo")
const policy = (name: string) => indigo().find((resource) => resource.metadata.name === name).spec
const roles = (spec: any) => spec.endpointSelector.matchExpressions[0].values
const controlRoles = [
  "argocd-application-controller",
  "argocd-applicationset-controller",
  "argocd-server",
]

test("Argo allowances are opt-in, egress-only and ordered before namespace enforcement", () => {
  const policies = indigo().filter((resource) => resource.kind === "CiliumNetworkPolicy")
  assert.equal(policies.length, 6)
  for (const resource of policies) {
    assert.equal(resource.metadata.namespace, "argocd")
    assert.equal(resource.metadata.annotations["argocd.argoproj.io/sync-wave"], "0")
    assert.deepEqual(resource.spec.enableDefaultDeny, { ingress: false, egress: false })
    assert.equal(resource.spec.ingress, undefined)
    assert.equal(resource.spec.endpointSelector.matchLabels["app.kubernetes.io/instance"], "argocd")
    assert.ok(roles(resource.spec).length > 0)
    for (const rule of resource.spec.egress) {
      assert.ok(rule.toEndpoints || rule.toEntities || rule.toFQDNs)
      assert.ok(rule.toPorts.length > 0)
      assert.ok(
        !(rule.toEntities ?? []).some((entity: string) =>
          ["all", "world", "cluster"].includes(entity),
        ),
      )
    }
  }
  assert.equal(
    render("gitops/components/argocd/overlays/hub-a").filter((resource) =>
      ["NetworkPolicy", "CiliumNetworkPolicy"].includes(resource.kind),
    ).length,
    0,
  )
  const bootstrap = render("gitops/clusters/indigo/bootstrap").find(
    (resource) => resource.kind === "AppProject" && resource.metadata.name === "bootstrap",
  )
  for (const kind of ["NetworkPolicy", "CiliumNetworkPolicy"]) {
    assert.ok(bootstrap.spec.namespaceResourceWhitelist.some((entry: any) => entry.kind === kind))
  }
})

test("Argo API, repository RPC and Redis access are component-specific", () => {
  const api = policy("argocd-kubernetes-api")
  assert.deepEqual(roles(api), [...controlRoles, "argocd-redis-secret-init"])
  assert.deepEqual(api.egress, [
    {
      toEntities: ["kube-apiserver"],
      toPorts: [{ ports: [{ port: "6443", protocol: "TCP" }] }],
    },
  ])
  for (const [name, clients, target, port] of [
    ["argocd-repository-rpc", controlRoles, "argocd-repo-server", "8081"],
    [
      "argocd-redis-clients",
      ["argocd-application-controller", "argocd-server", "argocd-repo-server"],
      "argocd-redis",
      "6379",
    ],
  ] as const) {
    const spec = policy(name)
    assert.deepEqual(roles(spec), clients)
    assert.deepEqual(spec.egress, [
      {
        toEndpoints: [
          {
            matchLabels: {
              "k8s:io.kubernetes.pod.namespace": "argocd",
              "app.kubernetes.io/instance": "argocd",
              "app.kubernetes.io/name": target,
            },
          },
        ],
        toPorts: [{ ports: [{ port, protocol: "TCP" }] }],
      },
    ])
  }
})

test("Only repo-server gets registry HTTPS and DNS inspection for FQDN enforcement", () => {
  const downloads = policy("argocd-repository-downloads")
  assert.deepEqual(roles(downloads), ["argocd-repo-server"])
  assert.deepEqual(downloads.egress[0].toPorts, [{ ports: [{ port: "443", protocol: "TCP" }] }])
  const hosts = downloads.egress[0].toFQDNs.map((host: any) => host.matchName)
  assert.deepEqual(hosts, [
    "github.com",
    "release-assets.githubusercontent.com",
    "ghcr.io",
    "pkg-containers.githubusercontent.com",
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudflare.docker.com",
    "production.cloudfront.docker.com",
    "helm.cilium.io",
    "charts.external-secrets.io",
    "external-secrets.io",
    "kubernetes-sigs.github.io",
    "metallb.github.io",
    "postfinance.github.io",
  ])
  for (const name of ["argocd-internal-dns", "argocd-repository-dns"]) {
    const dns = policy(name)
    assert.ok(!roles(dns).includes("argocd-redis"))
    assert.deepEqual(dns.egress[0].toEndpoints, [
      {
        matchLabels: {
          "k8s:io.kubernetes.pod.namespace": "kube-system",
          "k8s:k8s-app": "kube-dns",
        },
      },
    ])
    assert.deepEqual(dns.egress[0].toPorts[0].ports, [
      { port: "53", protocol: "UDP" },
      { port: "53", protocol: "TCP" },
    ])
  }
  const repositoryDNS = policy("argocd-repository-dns")
  assert.deepEqual(roles(repositoryDNS), ["argocd-repo-server"])
  assert.deepEqual(repositoryDNS.egress[0].toPorts[0].rules, { dns: [{ matchPattern: "*" }] })
  assert.equal(policy("argocd-internal-dns").egress[0].toPorts[0].rules, undefined)
  assert.ok(!roles(policy("argocd-internal-dns")).includes("argocd-repo-server"))
})

test("Argo denies namespace egress by default without changing chart-owned ingress", () => {
  const policies = indigo().filter((resource) => resource.kind === "NetworkPolicy")
  assert.equal(policies.length, 1)
  const deny = policies[0]
  assert.equal(deny.metadata.name, "argocd-default-deny-egress")
  assert.equal(deny.metadata.namespace, "argocd")
  assert.equal(deny.metadata.annotations["argocd.argoproj.io/sync-wave"], "1")
  assert.deepEqual(deny.spec, { podSelector: {}, policyTypes: ["Egress"] })
  // Redis has no outbound dependencies: replies to permitted inbound traffic
  // are stateful, so no outbound initiation allowance is necessary.
  const allowances = indigo().filter((resource) => resource.kind === "CiliumNetworkPolicy")
  assert.ok(allowances.every((resource) => !roles(resource.spec).includes("argocd-redis")))
})
