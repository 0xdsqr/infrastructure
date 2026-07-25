import { Path } from "@effect/platform"
import { Console, Effect } from "effect"

import { GitOpsUsageError } from "./errors.ts"
import {
  listDirectories,
  listFilesRecursive,
  renderKustomization,
  requirePathType,
  resolveDirectory,
  validate,
} from "./runtime.ts"

export const gitOpsRenderUsage = `Usage:
  gitops-render [--repo-root PATH]

Render every cluster bootstrap, Application collection, and component
overlay. Output is discarded; success means every declared surface rendered.`

export type GitOpsRenderOptions = {
  readonly repoRoot: string
}

export const parseGitOpsRenderArguments = (
  argv: readonly string[],
  currentDirectory: string,
): Effect.Effect<GitOpsRenderOptions | "help", GitOpsUsageError> => {
  let repoRoot = currentDirectory

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "-h" || argument === "--help") {
      return Effect.succeed("help")
    }
    if (argument === "--repo-root") {
      const value = argv[index + 1]
      if (value === undefined) {
        return Effect.fail(new GitOpsUsageError({ message: "--repo-root requires a path" }))
      }
      repoRoot = value
      index += 1
      continue
    }
    return Effect.fail(
      new GitOpsUsageError({
        message: `Unknown argument: ${argument}\n${gitOpsRenderUsage}`,
      }),
    )
  }

  return Effect.succeed({ repoRoot })
}

export const renderGitOps = Effect.fn("GitOps.render")(function* (options: GitOpsRenderOptions) {
  const path = yield* Path.Path
  const repoRoot = yield* resolveDirectory(options.repoRoot)
  const clustersRoot = path.join(repoRoot, "gitops", "clusters")
  const componentsRoot = path.join(repoRoot, "gitops", "components")

  const expectedTreeMessage = `Expected gitops/clusters and gitops/components under ${repoRoot}`
  yield* requirePathType(clustersRoot, "Directory", expectedTreeMessage)
  yield* requirePathType(componentsRoot, "Directory", expectedTreeMessage)

  const clusterDirectories = yield* listDirectories(clustersRoot)
  yield* validate(
    clusterDirectories.length > 0,
    `No GitOps clusters are declared under ${clustersRoot}`,
  )
  yield* Effect.forEach(
    clusterDirectories,
    (clusterDirectory) =>
      Effect.all(
        [
          renderKustomization(path.join(clusterDirectory, "bootstrap")),
          renderKustomization(path.join(clusterDirectory, "applications")),
        ],
        { concurrency: 1, discard: true },
      ),
    { concurrency: 1, discard: true },
  )

  const componentFiles = yield* listFilesRecursive(componentsRoot)
  const overlayKustomizations = componentFiles.filter((file) => {
    const relative = path.relative(componentsRoot, file)
    const segments = relative.split(path.sep)
    return (
      segments.length >= 4 &&
      segments.at(-3) === "overlays" &&
      segments.at(-1) === "kustomization.yaml"
    )
  })
  yield* validate(
    overlayKustomizations.length > 0,
    `No component overlays are declared under ${componentsRoot}`,
  )
  yield* Effect.forEach(
    overlayKustomizations,
    (kustomization) => renderKustomization(path.dirname(kustomization)),
    { concurrency: 1, discard: true },
  )

  yield* Console.log(
    `Rendered ${clusterDirectories.length} cluster(s) and ${overlayKustomizations.length} component overlay(s).`,
  )
})

export const runGitOpsRenderCli = Effect.fn("GitOps.renderCli")(function* (
  argv: readonly string[],
) {
  const currentDirectory = yield* resolveDirectory(".")
  const options = yield* parseGitOpsRenderArguments(argv, currentDirectory)
  if (options === "help") {
    yield* Console.log(gitOpsRenderUsage)
    return
  }
  yield* renderGitOps(options)
})
