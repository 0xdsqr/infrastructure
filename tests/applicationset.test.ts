import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const applicationSet = () =>
  parseAllDocuments(
    execFileSync("kubectl", ["kustomize", "gitops/clusters/indigo/applications"], {
      encoding: "utf8",
    }),
  )[0]!.toJSON()

test("Indigo has one protected native owner for all platform Applications", () => {
  const owner = applicationSet()
  assert.equal(owner.kind, "ApplicationSet")
  assert.equal(owner.metadata.name, "indigo-platform")
  assert.equal(owner.metadata.namespace, "argocd")
  assert.equal(
    owner.metadata.annotations["argocd.argoproj.io/sync-options"],
    "Prune=confirm,Delete=confirm",
  )
  const apps = previewApplicationSet(owner)
  assert.equal(apps.length, 14)
  assert.ok(apps.some((app) => (app.metadata as { name: string }).name === "argocd"))
  for (const app of apps) {
    const metadata = app.metadata as { namespace: string; finalizers?: string[] }
    assert.equal(metadata.namespace, "argocd")
    assert.equal(metadata.finalizers, undefined)
  }
})

test("native inventory rejects empty, duplicate and unknown lifecycle entries", () => {
  for (const mutation of ["empty", "duplicate", "lifecycle", "missing-field"]) {
    const owner = applicationSet()
    const inventory = owner.spec.generators[0].matrix.generators[1].list.elements
    if (mutation === "empty") inventory.splice(0)
    if (mutation === "duplicate") inventory.push(structuredClone(inventory[0]))
    if (mutation === "lifecycle") inventory[0].lifecycle = "unreviewed"
    if (mutation === "missing-field") delete inventory[0].namespace
    assert.throws(() => previewApplicationSet(owner))
  }
})

test("native inventory cannot silently enable destructive deletion policies", () => {
  const owner = applicationSet()
  owner.spec.syncPolicy.applicationsSync = "sync"
  assert.throws(() => previewApplicationSet(owner), /preserve/)
  owner.spec.syncPolicy.applicationsSync = "create-update"
  owner.spec.syncPolicy.preserveResourcesOnDeletion = false
  assert.throws(() => previewApplicationSet(owner), /preserve/)
})

test("native sync approval follows lifecycle, not hardcoded Application names", () => {
  const owner = applicationSet()
  const inventory = owner.spec.generators[0].matrix.generators[1].list.elements
  for (const component of inventory) component.name = `future-${component.name}`
  for (const app of previewApplicationSet(owner)) {
    const metadata = app.metadata as { labels: Record<string, string> }
    const spec = app.spec as { syncPolicy: { automated: unknown } }
    const automatic = metadata.labels["platform.dsqr.dev/lifecycle"] !== "controller"
    assert.deepEqual(spec.syncPolicy.automated, {
      enabled: automatic,
      selfHeal: automatic,
      prune: automatic,
      allowEmpty: false,
    })
  }
})

test("every managed Indigo namespace requires prune and deletion confirmation", () => {
  const resources = parseAllDocuments(
    execFileSync("kubectl", ["kustomize", "gitops/components/cluster-foundation/overlays/indigo"], {
      encoding: "utf8",
    }),
  ).map((document) => document.toJSON())
  const namespaces = resources.filter((resource) => resource.kind === "Namespace")
  assert.equal(namespaces.length, 5)
  for (const namespace of namespaces) {
    const options = namespace.metadata.annotations["argocd.argoproj.io/sync-options"].split(",")
    assert.ok(options.includes("Prune=confirm"), namespace.metadata.name)
    assert.ok(options.includes("Delete=confirm"), namespace.metadata.name)
  }
})
