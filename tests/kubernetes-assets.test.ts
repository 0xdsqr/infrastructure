import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { after, test } from "node:test"

import * as pulumi from "@pulumi/pulumi"
import type { MockResourceArgs } from "@pulumi/pulumi/runtime"
import { Effect } from "effect"

import type { KubernetesPlatformArgs } from "@dsqr/pulumi-kubernetes"
import { runPulumiProgram } from "@dsqr/pulumi-shared"

import {
  createKubernetesStackEffect,
  KubernetesAssetPreflightError,
} from "../infra/kubernetes/preflight.ts"

const resources: MockResourceArgs[] = []
const temporaryRoots: string[] = []

await pulumi.runtime.setMocks(
  {
    call: (args) => args.inputs,
    newResource: (args) => {
      resources.push(args)
      return { id: `${args.name}-id`, state: args.inputs }
    },
  },
  "infrastructure",
  "dev",
  true,
)

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true })
  }
})

const makeStackRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "kubernetes-assets-"))
  temporaryRoots.push(root)
  return root
}

const platformArgs = (
  stackRoot: string,
  helmReleases: KubernetesPlatformArgs["helmReleases"],
): KubernetesPlatformArgs => ({
  stackRoot,
  namespaces: {},
  helmReleases,
  metallbAddressPools: {},
  metallbL2Advertisements: {},
})

const runStack = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

test("Kubernetes asset preflight can cross the synchronous Pulumi program boundary", () => {
  const stackRoot = makeStackRoot()
  const valuesPath = path.join(stackRoot, "values", "application.yaml")
  mkdirSync(path.dirname(valuesPath), { recursive: true })
  writeFileSync(valuesPath, "replicaCount: 1\n")
  const result = runPulumiProgram(
    createKubernetesStackEffect(
      platformArgs(stackRoot, {
        application: {
          releaseName: "application",
          namespace: "default",
          chart: "application",
          repository: "https://example.invalid/charts",
          valueYamlFiles: ["values/application.yaml"],
        },
      }),
    ),
  )

  assert.ok("application" in result.releases)
})

test("Kubernetes asset preflight rejects a missing values file before registration", async () => {
  const resourceCount = resources.length
  const error = await runStack(
    Effect.flip(
      createKubernetesStackEffect(
        platformArgs(makeStackRoot(), {
          application: {
            releaseName: "application",
            namespace: "default",
            chart: "application",
            repository: "https://example.invalid/charts",
            valueYamlFiles: ["values/application.yaml"],
          },
        }),
      ),
    ),
  )

  assert.ok(error instanceof KubernetesAssetPreflightError)
  assert.equal(error.assetKind, "values")
  assert.match(error.message, /Unable to inspect values asset/)
  assert.equal(resources.length, resourceCount)
})

test("Kubernetes asset preflight rejects the wrong local chart shape before registration", async () => {
  const stackRoot = makeStackRoot()
  const chartPath = path.join(stackRoot, "charts", "application")
  mkdirSync(path.dirname(chartPath), { recursive: true })
  writeFileSync(chartPath, "not a chart directory")

  const resourceCount = resources.length
  const error = await runStack(
    Effect.flip(
      createKubernetesStackEffect(
        platformArgs(stackRoot, {
          application: {
            releaseName: "application",
            namespace: "default",
            chart: "charts/application",
          },
        }),
      ),
    ),
  )

  assert.ok(error instanceof KubernetesAssetPreflightError)
  assert.equal(error.assetKind, "chart")
  assert.equal(error.expectedType, "Directory")
  assert.match(error.message, /found file/)
  assert.equal(resources.length, resourceCount)
})

test("Kubernetes asset preflight requires Chart.yaml for local chart directories", async () => {
  const stackRoot = makeStackRoot()
  mkdirSync(path.join(stackRoot, "charts", "application"), { recursive: true })

  const resourceCount = resources.length
  const error = await runStack(
    Effect.flip(
      createKubernetesStackEffect(
        platformArgs(stackRoot, {
          application: {
            releaseName: "application",
            namespace: "default",
            chart: "charts/application",
          },
        }),
      ),
    ),
  )

  assert.ok(error instanceof KubernetesAssetPreflightError)
  assert.equal(error.assetKind, "chart metadata")
  assert.match(error.assetPath, /Chart\.yaml$/)
  assert.equal(resources.length, resourceCount)
})

test("Kubernetes asset preflight ignores disabled release assets", async () => {
  const resourceCount = resources.length
  const result = await runStack(
    createKubernetesStackEffect(
      platformArgs(makeStackRoot(), {
        disabled: {
          releaseName: "disabled",
          namespace: "default",
          chart: "missing/chart",
          enabled: false,
          valueYamlFiles: ["missing/values.yaml"],
        },
      }),
    ),
  )

  assert.deepEqual(result.releases, {})
  assert.equal(resources.length, resourceCount)
})
