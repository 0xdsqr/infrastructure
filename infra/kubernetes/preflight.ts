import { statSync } from "node:fs"
import * as path from "node:path"

import { Data, Effect } from "effect"

import {
  createKubernetesPlatformEffect,
  type HelmReleaseInventoryLike,
  type KubernetesPlatformArgs,
} from "@dsqr/pulumi-kubernetes"

type KubernetesAssetKind = "chart" | "chart metadata" | "values"
type KubernetesAssetType = "Directory" | "File"

export class KubernetesAssetPreflightError extends Data.TaggedError(
  "KubernetesAssetPreflightError",
)<{
  readonly assetKind: KubernetesAssetKind
  readonly assetPath: string
  readonly cause: unknown
  readonly expectedType: KubernetesAssetType
  readonly releaseKey: string
  readonly message: string
}> {}

export type KubernetesAssetPreflightArgs = Pick<
  KubernetesPlatformArgs,
  "stackRoot" | "helmReleases"
>

const assetLabel = (kind: KubernetesAssetKind) =>
  kind === "chart metadata" ? "chart metadata" : `${kind} asset`

const inspectAsset = Effect.fn("KubernetesAssetPreflight.inspectAsset")(function* (
  releaseKey: string,
  kind: KubernetesAssetKind,
  assetPath: string,
  expectedType: KubernetesAssetType,
) {
  const label = assetLabel(kind)
  const actualType = yield* Effect.try({
    try: () => {
      const info = statSync(assetPath)
      return info.isDirectory() ? "Directory" : info.isFile() ? "File" : "Other"
    },
    catch: (cause) =>
      new KubernetesAssetPreflightError({
        assetKind: kind,
        assetPath,
        cause,
        expectedType,
        releaseKey,
        message: `Unable to inspect ${label} for enabled Helm release "${releaseKey}" at ${assetPath}.`,
      }),
  })

  if (actualType !== expectedType) {
    return yield* new KubernetesAssetPreflightError({
      assetKind: kind,
      assetPath,
      cause: undefined,
      expectedType,
      releaseKey,
      message: `The ${label} for enabled Helm release "${releaseKey}" must be a ${expectedType.toLowerCase()} at ${assetPath}; found ${actualType.toLowerCase()}.`,
    })
  }
})

const inspectLocalChart = Effect.fn("KubernetesAssetPreflight.inspectLocalChart")(function* (
  stackRoot: string,
  releaseKey: string,
  spec: HelmReleaseInventoryLike[string],
) {
  if (spec.repository) {
    return
  }

  const chartPath = path.resolve(stackRoot, spec.chart)

  if (path.extname(chartPath) === ".tgz") {
    yield* inspectAsset(releaseKey, "chart", chartPath, "File")
    return
  }

  yield* inspectAsset(releaseKey, "chart", chartPath, "Directory")
  yield* inspectAsset(releaseKey, "chart metadata", path.join(chartPath, "Chart.yaml"), "File")
})

export const preflightKubernetesAssets = Effect.fn("KubernetesAssetPreflight.run")(function* (
  args: KubernetesAssetPreflightArgs,
) {
  for (const [releaseKey, spec] of Object.entries(args.helmReleases)) {
    if (spec.enabled === false) {
      continue
    }

    yield* inspectLocalChart(args.stackRoot, releaseKey, spec)

    for (const valueYamlFile of spec.valueYamlFiles ?? []) {
      yield* inspectAsset(releaseKey, "values", path.resolve(args.stackRoot, valueYamlFile), "File")
    }
  }
})

export const createKubernetesStackEffect = Effect.fn("KubernetesStack.create")(function* (
  args: KubernetesPlatformArgs,
) {
  yield* preflightKubernetesAssets(args)
  return yield* createKubernetesPlatformEffect(args)
})
