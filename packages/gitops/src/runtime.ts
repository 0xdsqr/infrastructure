import { Command, FileSystem, Path } from "@effect/platform"
import { Effect, Stream } from "effect"
import { parse, parseAllDocuments } from "yaml"

import {
  GitOpsCommandError,
  GitOpsFileSystemError,
  GitOpsValidationError,
  GitOpsYamlError,
} from "./errors.ts"

export type YamlRecord = Readonly<Record<string, unknown>>

export const isRecord = (value: unknown): value is YamlRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const asRecord = (value: unknown): YamlRecord | undefined =>
  isRecord(value) ? value : undefined

export const asArray = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? value : undefined

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

export const field = (record: YamlRecord | undefined, name: string): unknown => record?.[name]

export const nestedRecord = (
  record: YamlRecord | undefined,
  ...names: readonly string[]
): YamlRecord | undefined => {
  let current: YamlRecord | undefined = record
  for (const name of names) {
    current = asRecord(field(current, name))
  }
  return current
}

export const nestedValue = (
  record: YamlRecord | undefined,
  ...names: readonly string[]
): unknown => {
  if (names.length === 0) {
    return record
  }

  const parent = nestedRecord(record, ...names.slice(0, -1))
  return field(parent, names.at(-1)!)
}

export const validate = (
  condition: boolean,
  message: string,
  path?: string,
): Effect.Effect<void, GitOpsValidationError> =>
  condition
    ? Effect.void
    : Effect.fail(
        new GitOpsValidationError({
          message,
          ...(path === undefined ? {} : { path }),
        }),
      )

export const mapFileSystemError =
  (path: string, message: string) =>
  (cause: unknown): GitOpsFileSystemError =>
    new GitOpsFileSystemError({ cause, message, path })

export const resolveDirectory = Effect.fn("GitOps.resolveDirectory")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem
    .realPath(directory)
    .pipe(
      Effect.mapError(
        mapFileSystemError(directory, `Unable to resolve repository directory ${directory}.`),
      ),
    )
})

export const pathExists = Effect.fn("GitOps.pathExists")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem
    .exists(path)
    .pipe(Effect.mapError(mapFileSystemError(path, `Unable to inspect ${path}.`)))
})

export const pathType = Effect.fn("GitOps.pathType")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const info = yield* fileSystem
    .stat(path)
    .pipe(Effect.mapError(mapFileSystemError(path, `Unable to inspect ${path}.`)))
  return info.type
})

export const requirePathType = Effect.fn("GitOps.requirePathType")(function* (
  path: string,
  expectedType: "Directory" | "File",
  message: string,
) {
  if (!(yield* pathExists(path))) {
    return yield* new GitOpsValidationError({ message, path })
  }
  yield* validate((yield* pathType(path)) === expectedType, message, path)
})

export const readText = Effect.fn("GitOps.readText")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem
    .readFileString(path)
    .pipe(Effect.mapError(mapFileSystemError(path, `Unable to read ${path}.`)))
})

export const writeText = Effect.fn("GitOps.writeText")(function* (
  path: string,
  contents: string,
  options?: Parameters<FileSystem.FileSystem["writeFileString"]>[2],
) {
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem
    .writeFileString(path, contents, options)
    .pipe(Effect.mapError(mapFileSystemError(path, `Unable to write ${path}.`)))
})

export const readYamlRecord = Effect.fn("GitOps.readYamlRecord")(function* (path: string) {
  const source = yield* readText(path)
  const value = yield* Effect.try({
    try: () => parse(source) as unknown,
    catch: (cause) =>
      new GitOpsYamlError({
        cause,
        message: `Unable to parse YAML document ${path}.`,
        path,
      }),
  })

  if (!isRecord(value)) {
    return yield* new GitOpsYamlError({
      cause: value,
      message: `Expected ${path} to contain one YAML mapping.`,
      path,
    })
  }

  return value
})

export const parseYamlDocuments = Effect.fn("GitOps.parseYamlDocuments")(function* (
  path: string,
  source: string,
) {
  const documents = yield* Effect.try({
    try: () =>
      parseAllDocuments(source).map((document) => {
        if (document.errors.length > 0) {
          throw document.errors[0]
        }
        return document.toJS() as unknown
      }),
    catch: (cause) =>
      new GitOpsYamlError({
        cause,
        message: `Unable to parse rendered YAML from ${path}.`,
        path,
      }),
  })

  return documents.filter(isRecord)
})

const listChildren = Effect.fn("GitOps.listChildren")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const canonicalDirectory = yield* fileSystem
    .realPath(directory)
    .pipe(Effect.mapError(mapFileSystemError(directory, `Unable to resolve ${directory}.`)))
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.mapError(mapFileSystemError(directory, `Unable to list ${directory}.`)))

  const children = yield* Effect.forEach(
    entries,
    (entry) => {
      const entryPath = path.join(directory, entry)
      return Effect.all({
        canonicalPath: fileSystem.realPath(entryPath),
        info: fileSystem.stat(entryPath),
      }).pipe(
        Effect.map(({ canonicalPath, info }) =>
          canonicalPath === path.join(canonicalDirectory, entry)
            ? { path: entryPath, type: info.type }
            : undefined,
        ),
        Effect.mapError(mapFileSystemError(entryPath, `Unable to inspect ${entryPath}.`)),
      )
    },
    { concurrency: "unbounded" },
  )

  const directories: string[] = []
  const files: string[] = []
  for (const child of children) {
    if (child?.type === "Directory") directories.push(child.path)
    if (child?.type === "File") files.push(child.path)
  }
  return { directories: directories.sort(), files: files.sort() }
})

export const listDirectories = (directory: string) =>
  listChildren(directory).pipe(Effect.map(({ directories }) => directories))

export const listFiles = (directory: string) =>
  listChildren(directory).pipe(Effect.map(({ files }) => files))

export const listFilesRecursive = (
  directory: string,
): Effect.Effect<readonly string[], GitOpsFileSystemError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const children = yield* listChildren(directory)
    const nestedFiles = yield* Effect.forEach(children.directories, listFilesRecursive, {
      concurrency: "unbounded",
    })
    return [...children.files, ...nestedFiles.flat()].sort()
  }).pipe(Effect.withSpan("GitOps.listFilesRecursive", { attributes: { directory } }))

export const snapshotDirectory = Effect.fn("GitOps.snapshotDirectory")(function* (
  directory: string,
) {
  const path = yield* Path.Path
  const files = yield* listFilesRecursive(directory)
  return yield* Effect.forEach(
    files,
    (file) =>
      readText(file).pipe(
        Effect.map((contents) => [path.relative(directory, file), contents] as const),
      ),
    { concurrency: "unbounded" },
  )
})

export type GitOpsCommand = {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd?: string
}

export const runCommand = Effect.fn("GitOps.runCommand")(function* (options: GitOpsCommand) {
  const baseCommand = Command.make(options.command, ...options.args)
  const command =
    options.cwd === undefined ? baseCommand : Command.workingDirectory(baseCommand, options.cwd)

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Command.start(command).pipe(
        Effect.mapError(
          (cause) =>
            new GitOpsCommandError({
              args: options.args,
              cause,
              command: options.command,
              message: `Unable to start ${options.command}.`,
            }),
        ),
      )
      const result = yield* Effect.all(
        {
          exitCode: process.exitCode,
          stderr: process.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold("", (output, chunk) => output + chunk),
          ),
          stdout: process.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold("", (output, chunk) => output + chunk),
          ),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new GitOpsCommandError({
              args: options.args,
              cause,
              command: options.command,
              message: `Unable to run ${options.command}.`,
            }),
        ),
      )

      if (result.exitCode !== 0) {
        return yield* new GitOpsCommandError({
          args: options.args,
          command: options.command,
          exitCode: result.exitCode,
          message: `${options.command} ${options.args.join(" ")} failed with exit code ${result.exitCode}.`,
          stderr: result.stderr.trim(),
        })
      }

      return {
        stderr: result.stderr,
        stdout: result.stdout,
      }
    }),
  )
})

export const renderKustomization = (directory: string) =>
  runCommand({
    command: "kubectl",
    args: ["kustomize", directory],
  }).pipe(Effect.map(({ stdout }) => stdout))
