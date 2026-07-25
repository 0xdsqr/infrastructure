import { FileSystem, Path } from "@effect/platform"
import { Config, Effect, Option } from "effect"

import { StackConfigError, StackDiscoveryError } from "./errors.ts"

export type StackProject = {
  readonly description: string
  readonly projectName?: string
}

export type StackDefinition = {
  readonly description: string
  readonly directory: URL
  readonly name: string
  readonly program: URL
  readonly projectName: string
}

export type ResolvedStack = Omit<StackDefinition, "directory" | "program"> & {
  readonly directory: string
  readonly program: string
}

export type StackRegistry = {
  readonly directory: string
  readonly groups: Readonly<Record<string, readonly string[]>>
  readonly ignoredProjects: ReadonlySet<string>
  readonly projectsDirectory: URL
  readonly rootDirectory: URL
  readonly stacks: Readonly<Record<string, StackDefinition>>
}

export type ResolvedStackRegistry = Omit<StackRegistry, "stacks"> & {
  readonly stacks: Readonly<Record<string, ResolvedStack>>
}

export type DefineStacksOptions = {
  readonly directory?: string
  readonly groups: Readonly<Record<string, readonly string[]>>
  readonly ignore?: readonly string[]
  readonly projects: Readonly<Record<string, StackProject>>
  readonly rootDirectory: URL
}

const defaultIgnoredProjects = ["tsconfig.json"] as const

const escapeRegularExpression = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const defineStacks = (options: DefineStacksOptions): StackRegistry => {
  const relativeDirectory = options.directory ?? "infra"
  const projectsDirectory = new URL(`${relativeDirectory}/`, options.rootDirectory)
  const stacks = Object.fromEntries(
    Object.entries(options.projects).map(([name, project]) => {
      const directory = new URL(`${name}/`, projectsDirectory)

      return [
        name,
        {
          description: project.description,
          directory,
          name,
          program: new URL("index.ts", directory),
          projectName: project.projectName ?? name,
        },
      ]
    }),
  )

  return {
    directory: relativeDirectory,
    groups: options.groups,
    ignoredProjects: new Set([...defaultIgnoredProjects, ...(options.ignore ?? [])]),
    projectsDirectory,
    rootDirectory: options.rootDirectory,
    stacks,
  }
}

const mapDiscoveryError =
  (directory: string, message: string) =>
  (cause: unknown): StackDiscoveryError =>
    new StackDiscoveryError({ cause, directory, message })

const resolveRootDirectory = Effect.fn("StackRegistry.resolveRootDirectory")(function* (
  registry: StackRegistry,
) {
  const path = yield* Path.Path
  const override = yield* Config.option(Config.string("INFRA_ROOT")).pipe(
    Effect.mapError(
      (cause) =>
        new StackDiscoveryError({
          cause,
          directory: registry.rootDirectory.href,
          message: "Unable to read the optional INFRA_ROOT runtime override.",
        }),
    ),
  )

  return Option.isSome(override)
    ? path.resolve(override.value)
    : yield* path
        .fromFileUrl(registry.rootDirectory)
        .pipe(
          Effect.mapError(
            mapDiscoveryError(
              registry.rootDirectory.href,
              `Unable to resolve infrastructure root ${registry.rootDirectory.href}.`,
            ),
          ),
        )
})

const discoverProjectNames = Effect.fn("StackRegistry.discoverProjectNames")(function* (
  registry: StackRegistry,
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(
      Effect.mapError(
        mapDiscoveryError(directory, `Unable to discover infrastructure projects in ${directory}.`),
      ),
    )

  const projects = yield* Effect.forEach(
    entries,
    (entry) => {
      if (registry.ignoredProjects.has(entry)) {
        return Effect.succeed(Option.none<string>())
      }

      const entryPath = path.join(directory, entry)
      return Effect.gen(function* () {
        const info = yield* fileSystem.stat(entryPath)
        if (info.type !== "Directory") {
          return Option.none<string>()
        }

        const hasProgram = yield* fileSystem.exists(path.join(entryPath, "index.ts"))
        return hasProgram ? Option.some(entry) : Option.none<string>()
      }).pipe(
        Effect.mapError(
          mapDiscoveryError(entryPath, `Unable to inspect infrastructure project ${entryPath}.`),
        ),
      )
    },
    { concurrency: "unbounded" },
  )

  return projects.flatMap(Option.toArray).sort()
})

const resolveStack = Effect.fn("StackRegistry.resolveStack")(function* (
  stack: StackDefinition,
  projectsDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(projectsDirectory, stack.name)
  const program = path.join(directory, "index.ts")
  const projectFile = path.join(directory, "Pulumi.yaml")
  const contents = yield* fileSystem
    .readFileString(projectFile)
    .pipe(
      Effect.mapError(
        mapDiscoveryError(directory, `Unable to read Pulumi project file ${projectFile}.`),
      ),
    )

  if (
    !new RegExp(`^name:\\s*${escapeRegularExpression(stack.projectName)}\\s*$`, "m").test(contents)
  ) {
    return yield* new StackConfigError({
      message: `${projectFile} must declare project name "${stack.projectName}".`,
    })
  }

  return {
    ...stack,
    directory,
    program,
  } satisfies ResolvedStack
})

export const resolveStackRegistry = Effect.fn("StackRegistry.resolve")(function* (
  registry: StackRegistry,
) {
  const path = yield* Path.Path
  const rootDirectory = yield* resolveRootDirectory(registry)
  const projectsDirectory = path.join(rootDirectory, registry.directory)
  const discoveredNames = yield* discoverProjectNames(registry, projectsDirectory)
  const configuredNames = Object.keys(registry.stacks).sort()

  if (discoveredNames.join("\0") !== configuredNames.join("\0")) {
    return yield* new StackConfigError({
      message: `Configured projects (${configuredNames.join(", ")}) must match discovered projects (${discoveredNames.join(", ")}).`,
    })
  }

  for (const [group, members] of Object.entries(registry.groups)) {
    for (const member of members) {
      if (!registry.stacks[member]) {
        return yield* new StackConfigError({
          message: `Group "${group}" references unknown project "${member}".`,
        })
      }
    }
  }

  const stackEntries = yield* Effect.forEach(
    Object.entries(registry.stacks),
    ([name, stack]) =>
      resolveStack(stack, projectsDirectory).pipe(
        Effect.map((resolved) => [name, resolved] as const),
      ),
    { concurrency: "unbounded" },
  )

  return {
    ...registry,
    stacks: Object.fromEntries(stackEntries),
  } satisfies ResolvedStackRegistry
})
