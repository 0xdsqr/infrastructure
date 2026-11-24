import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const render = (component: string) =>
  parseAllDocuments(
    execFileSync("kubectl", ["kustomize", `gitops/components/${component}/overlays/indigo`], {
      encoding: "utf8",
    }),
  )
    .map((d) => d.toJSON())
    .filter(Boolean)

test("Legacy TWT is a zero-replica, pinned, manual rollback deployment", () => {
  for (const app of ["web", "admin"]) {
    const application = parse(
      readFileSync(`gitops/clusters/hub-a/applications/twt-${app}.yaml`, "utf8"),
    )
    const values = parse(
      readFileSync(`gitops/components/twt-${app}/overlays/hub-a/values-overrides.yaml`, "utf8"),
    )
    assert.equal(values.replicaCount, 0)
    assert.equal(
      application.spec.sources[0].targetRevision,
      "6538cee87a65beba916f8366c4753e37054cd31b",
    )
    assert.deepEqual(application.spec.syncPolicy.automated, {
      enabled: false,
      prune: false,
      selfHeal: false,
    })
  }
})

test("TWT release data cannot choose deployment privileges or enable first-release auto-sync", () => {
  const set = render("application-set").find((r) => r.metadata.name === "indigo-twt")
  const apps = previewApplicationSet(set)
  assert.deepEqual(
    apps.map((a) => (a.metadata as any).name),
    ["twt-web", "twt-admin"],
  )
  for (const app of apps) {
    const spec = app.spec as any
    assert.equal(spec.project, "twt")
    assert.equal(spec.destination.namespace, "twt")
    assert.equal(spec.sources[0].repoURL, "https://github.com/0xdsqr/tastingswithtay.git")
    assert.equal(spec.sources[0].path, "helm/twt-app")
    assert.equal(spec.sources[0].targetRevision, "0".repeat(40))
    assert.equal(spec.syncPolicy.automated.enabled, false)
    assert.equal(spec.syncPolicy.automated.prune, false)
  }
  set.spec.generators[0].matrix.generators[0].list.elements[0].name = "../escape"
  assert.throws(() => previewApplicationSet(set), /safe public app name/)
})

test("TWT has exact Indigo Vault paths, no admin Discord secret, and verified database trust", () => {
  const resources = render("external-secrets-config")
  for (const app of ["web", "admin"]) {
    const secret = resources.find(
      (r) => r.kind === "ExternalSecret" && r.metadata.name === `twt-${app}-secrets`,
    )
    assert.equal(secret.metadata.namespace, "twt")
    assert.equal(secret.spec.secretStoreRef.name, "vault-indigo")
    assert.equal(secret.spec.target.deletionPolicy, "Retain")
    assert.deepEqual(
      secret.spec.data.map((d: any) => d.secretKey).sort(),
      [
        "AUTH_SECRET",
        "DATABASE_URL",
        ...(app === "web" ? ["DISCORD_CLIENT_SECRET"] : []),
        "S3_ACCESS_KEY",
        "S3_SECRET_KEY",
      ].sort(),
    )
    for (const field of secret.spec.data)
      assert.equal(field.remoteRef.key, `dsqr-labs/clusters/indigo/apps/twt-${app}`)
  }
  assert.ok(
    resources.some(
      (r) =>
        r.kind === "ConfigMap" &&
        r.metadata.name === "dsqr-home-root-ca" &&
        r.metadata.namespace === "twt",
    ),
  )
})

test("TWT namespace is restricted and Envoy can reach only the two exact application ports", () => {
  const namespace = render("cluster-foundation").find(
    (r) => r.kind === "Namespace" && r.metadata.name === "twt",
  )
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted")
  const policy = render("gateway").find((r) => r.metadata.name === "envoy-shared-to-twt")
  assert.equal(policy.spec.egress.length, 2)
  for (const [index, app] of ["web", "admin"].entries()) {
    const rule = policy.spec.egress[index]
    assert.deepEqual(rule.toEndpoints, [
      {
        matchLabels: {
          "k8s:io.kubernetes.pod.namespace": "twt",
          "k8s:io.cilium.k8s.policy.serviceaccount": `twt-${app}`,
          "app.kubernetes.io/instance": `twt-${app}`,
          "app.kubernetes.io/name": "twt-app",
        },
      },
    ])
    assert.deepEqual(rule.toPorts, [{ ports: [{ port: String(3010 + index), protocol: "TCP" }] }])
  }
})
