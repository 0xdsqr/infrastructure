import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { parseAllDocuments } from "yaml"

const render = (path: string) =>
  parseAllDocuments(execFileSync("kubectl", ["kustomize", path], { encoding: "utf8" })).map(
    (document) => document.toJSON(),
  )

test("Indigo stages ESO allowances before namespace isolation; hub-a is unchanged", () => {
  const resources = render("gitops/components/external-secrets-config/overlays/indigo")
  const policies = resources.filter((resource) =>
    ["NetworkPolicy", "CiliumNetworkPolicy"].includes(resource.kind),
  )
  assert.equal(policies.length, 4)
  const deny = policies.find((policy) => policy.kind === "NetworkPolicy")
  assert.deepEqual(deny.spec.podSelector, {})
  assert.deepEqual(deny.spec.policyTypes, ["Ingress", "Egress"])
  assert.equal(deny.metadata.annotations["argocd.argoproj.io/sync-wave"], "1")
  for (const policy of policies.filter((policy) => policy.kind === "CiliumNetworkPolicy")) {
    assert.equal(policy.metadata.namespace, "external-secrets")
    assert.equal(policy.metadata.annotations["argocd.argoproj.io/sync-wave"], "0")
    assert.deepEqual(policy.spec.enableDefaultDeny, { ingress: false, egress: false })
  }
  assert.equal(
    render("gitops/components/external-secrets-config/overlays/hub-a").filter((resource) =>
      ["NetworkPolicy", "CiliumNetworkPolicy"].includes(resource.kind),
    ).length,
    0,
  )
})

test("ESO traffic is limited to DNS, API, controller-only Vault, probes and monitoring", () => {
  const resources = render("gitops/components/external-secrets-config/overlays/indigo")
  const policy = (name: string) =>
    resources.find((resource) => resource.metadata.name === name).spec
  const operator = policy("external-secrets-operator-access")
  assert.equal(operator.egress.length, 2)
  assert.deepEqual(operator.egress[0].toEndpoints, [
    {
      matchLabels: {
        "k8s:io.kubernetes.pod.namespace": "kube-system",
        "k8s:k8s-app": "kube-dns",
      },
    },
  ])
  assert.deepEqual(operator.egress[0].toPorts[0].ports, [
    { port: "53", protocol: "UDP" },
    { port: "53", protocol: "TCP" },
  ])
  assert.deepEqual(operator.egress[1], {
    toEntities: ["kube-apiserver"],
    toPorts: [{ ports: [{ port: "6443", protocol: "TCP" }] }],
  })
  const vault = policy("external-secrets-vault-access")
  assert.equal(vault.endpointSelector.matchLabels["app.kubernetes.io/name"], "external-secrets")
  assert.deepEqual(vault.egress, [
    { toCIDR: ["10.10.30.110/32"], toPorts: [{ ports: [{ port: "8200", protocol: "TCP" }] }] },
  ])
  const webhook = policy("external-secrets-webhook-access")
  assert.equal(
    webhook.endpointSelector.matchLabels["app.kubernetes.io/name"],
    "external-secrets-webhook",
  )
  assert.deepEqual(webhook.ingress, [
    {
      fromEntities: ["kube-apiserver", "remote-node"],
      toPorts: [{ ports: [{ port: "10250", protocol: "TCP" }] }],
    },
  ])
  assert.equal(
    operator.ingress[0].fromEndpoints[0].matchLabels["k8s:io.kubernetes.pod.namespace"],
    "observability",
  )
  assert.deepEqual(operator.ingress[0].toPorts[0].ports, [{ port: "8080", protocol: "TCP" }])
  assert.deepEqual(operator.ingress[1], {
    fromEntities: ["host"],
    toPorts: [{ ports: [{ port: "8081", protocol: "TCP" }] }],
  })
})
