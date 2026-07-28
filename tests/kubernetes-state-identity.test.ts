import { strict as assert } from "node:assert"
import { test } from "node:test"
import * as path from "node:path"

import { createKubernetesPlatformEffect } from "@dsqr/pulumi-kubernetes"
import { runPulumiProgram } from "@dsqr/pulumi-shared"

import { kubernetes } from "../infra/kubernetes/config.ts"
import { byName, runPulumiMockProgram } from "./pulumi-state-helpers.ts"

const namespaceToken = "kubernetes:core/v1:Namespace"
const releaseToken = "kubernetes:helm.sh/v3:Release"

test("Kubernetes preserves the Pulumi-owned Argo namespace and release contract", async () => {
  const stackRoot = path.resolve("infra/kubernetes")
  const deployment = await runPulumiMockProgram({
    program: () =>
      runPulumiProgram(
        createKubernetesPlatformEffect({
          stackRoot,
          namespaces: kubernetes.namespaces,
          helmReleases: kubernetes.helmReleases,
          metallbAddressPools: kubernetes.metallb.addressPools,
          metallbL2Advertisements: kubernetes.metallb.l2Advertisements,
        }),
      ),
    outputs: (result) => ({
      namespaces: result.namespaces,
      releases: result.releases,
    }),
    project: "kubernetes",
  })

  const resources = deployment.resources.filter((resource) =>
    resource.type.startsWith("kubernetes:"),
  )
  assert.deepEqual(
    resources
      .map((resource) => [resource.type, resource.name] as const)
      .sort((left, right) => left[1].localeCompare(right[1])),
    [
      [namespaceToken, "argocd"],
      [releaseToken, "argoCd"],
    ],
  )

  const namespace = byName(resources, "argocd")
  assert.deepEqual(namespace.inputs.metadata, {
    annotations: {
      "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
    },
    labels: {
      "app.kubernetes.io/managed-by": "pulumi",
      "app.kubernetes.io/part-of": "dsqr-gitops",
      "homelab.dev/cluster": "hub-a",
      "homelab.dev/environment": "homelab",
      "homelab.dev/owner": "platform",
      "homelab.dev/physical-host": "dell-r730xd",
      "homelab.dev/tier": "gitops",
      "pod-security.kubernetes.io/enforce": "baseline",
    },
    name: "argocd",
  })

  const release = byName(resources, "argoCd")
  assert.deepEqual(
    {
      name: release.inputs.name,
      namespace: release.inputs.namespace,
      chart: release.inputs.chart,
      createNamespace: release.inputs.createNamespace,
      skipAwait: release.inputs.skipAwait,
      atomic: release.inputs.atomic,
      cleanupOnFail: release.inputs.cleanupOnFail,
      repositoryOpts: release.inputs.repositoryOpts,
      version: release.inputs.version,
    },
    {
      name: "argocd",
      namespace: "argocd",
      chart: "argo-cd",
      createNamespace: false,
      skipAwait: false,
      atomic: true,
      cleanupOnFail: true,
      repositoryOpts: {
        repo: "https://argoproj.github.io/argo-helm",
      },
      version: "10.2.1",
    },
  )
  assert.deepEqual(kubernetes.helmReleases.argoCd.valueYamlFiles, [
    "../../gitops/values/argocd/common.yaml",
    "../../gitops/values/argocd/hub-a.yaml",
  ])

  const namespaceOptions = byName(deployment.captured, "argocd")
  assert.equal(namespace.provider, "")
  assert.equal(namespaceOptions.opts.parent, undefined)
  assert.equal(namespaceOptions.opts.provider, undefined)
  assert.equal(namespaceOptions.opts.dependsOn, undefined)
  assert.equal(namespaceOptions.opts.protect, undefined)
  assert.equal(namespaceOptions.opts.retainOnDelete, undefined)
  assert.equal(namespaceOptions.opts.ignoreChanges, undefined)

  const releaseOptions = byName(deployment.captured, "argoCd")
  assert.equal(release.provider, "")
  assert.equal(releaseOptions.opts.parent, undefined)
  assert.equal(releaseOptions.opts.provider, undefined)
  assert.deepEqual(releaseOptions.opts.dependsOn, [namespaceOptions.resource])
  assert.equal(releaseOptions.opts.protect, undefined)
  assert.equal(releaseOptions.opts.retainOnDelete, undefined)
  assert.equal(releaseOptions.opts.ignoreChanges, undefined)
})
