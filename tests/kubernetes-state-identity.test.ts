import { strict as assert } from "node:assert"
import { test } from "node:test"
import { createKubernetesPlatformEffect } from "@dsqr/pulumi-kubernetes"
import { runPulumiProgram } from "@dsqr/pulumi-shared"
import { kubernetes } from "../infra/kubernetes/config.ts"
import { runPulumiMockProgram } from "./pulumi-state-helpers.ts"

test("Retired Hub-A creates no Kubernetes resources", async () => {
  const result = await runPulumiMockProgram({
    program: () =>
      runPulumiProgram(
        createKubernetesPlatformEffect({
          stackRoot: process.cwd(),
          namespaces: kubernetes.namespaces,
          helmReleases: kubernetes.helmReleases,
          metallbAddressPools: kubernetes.metallb.addressPools,
          metallbL2Advertisements: kubernetes.metallb.l2Advertisements,
        }),
      ),
    outputs: () => ({}),
    project: "kubernetes",
  })
  assert.deepEqual(
    result.resources.filter((r) => r.type.startsWith("kubernetes:")),
    [],
  )
  assert.deepEqual(kubernetes.namespaces, {})
  assert.deepEqual(kubernetes.helmReleases, {})
})
