import * as FileSystem from "@effect/platform/FileSystem"
import type { PlatformError } from "@effect/platform/Error"
import * as Path from "@effect/platform/Path"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Cause, Console, Data, Effect, Either, Option } from "effect"

export const PROXMOX_V7_VM_TOKEN = "proxmoxve:VM/virtualMachine:VirtualMachine"
export const PROXMOX_V8_VM_TOKEN = "proxmoxve:index/vmLegacy:VmLegacy"
export const PULUMI_STATE_FILE_SUFFIX = ".pulumi-state.json"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type ProxmoxStateMigrationSummary = {
  readonly replacements: number
  readonly inputNewTokenCount: number
  readonly outputNewTokenCount: number
}

export type ProxmoxStateMigrationResult = ProxmoxStateMigrationSummary & {
  readonly state: JsonValue
}

export class ProxmoxStateMigrationUsageError extends Data.TaggedError(
  "ProxmoxStateMigrationUsageError",
)<{
  readonly message: string
}> {}

export class ProxmoxStateMigrationPathError extends Data.TaggedError(
  "ProxmoxStateMigrationPathError",
)<{
  readonly inputPath: string
  readonly message: string
  readonly outputPath: string
  readonly reason: "UnsafeFilename" | "SamePath" | "SameEntry" | "OutputExists"
}> {}

export class ProxmoxStateMigrationJsonError extends Data.TaggedError(
  "ProxmoxStateMigrationJsonError",
)<{
  readonly cause: unknown
  readonly inputPath: string
  readonly message: string
}> {}

export class ProxmoxStateMigrationInvariantError extends Data.TaggedError(
  "ProxmoxStateMigrationInvariantError",
)<{
  readonly message: string
  readonly reason: "NoSourceTokens" | "OldTokensRemain" | "TokenCountMismatch"
}> {}

export class ProxmoxStateMigrationFileSystemError extends Data.TaggedError(
  "ProxmoxStateMigrationFileSystemError",
)<{
  readonly cause: PlatformError
  readonly message: string
  readonly operation: "RealPath" | "Read" | "Write"
  readonly path: string
}> {}

export type ProxmoxStateMigrationError =
  | ProxmoxStateMigrationUsageError
  | ProxmoxStateMigrationPathError
  | ProxmoxStateMigrationJsonError
  | ProxmoxStateMigrationInvariantError
  | ProxmoxStateMigrationFileSystemError

const segment = (token: string): string => `::${token}::`

const countInString = (value: string, token: string): number =>
  value === token ? 1 : value.split(segment(token)).length - 1

export const countTokenOccurrences = (value: JsonValue, token: string): number => {
  if (typeof value === "string") {
    return countInString(value, token)
  }

  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + countTokenOccurrences(item, token), 0)
  }

  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>(
      (total, item) => total + countTokenOccurrences(item, token),
      0,
    )
  }

  return 0
}

const replaceToken = (value: JsonValue): JsonValue => {
  if (typeof value === "string") {
    return value === PROXMOX_V7_VM_TOKEN
      ? PROXMOX_V8_VM_TOKEN
      : value.replaceAll(segment(PROXMOX_V7_VM_TOKEN), segment(PROXMOX_V8_VM_TOKEN))
  }

  if (Array.isArray(value)) {
    return value.map(replaceToken)
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceToken(item)]))
  }

  return value
}

export const transformProxmoxV7State = (
  input: JsonValue,
): Effect.Effect<ProxmoxStateMigrationResult, ProxmoxStateMigrationInvariantError> =>
  Effect.gen(function* () {
    const replacements = countTokenOccurrences(input, PROXMOX_V7_VM_TOKEN)

    if (replacements === 0) {
      return yield* new ProxmoxStateMigrationInvariantError({
        message: `Input contains no ${PROXMOX_V7_VM_TOKEN} occurrences`,
        reason: "NoSourceTokens",
      })
    }

    const inputNewTokenCount = countTokenOccurrences(input, PROXMOX_V8_VM_TOKEN)
    const state = replaceToken(input)
    const outputOldTokenCount = countTokenOccurrences(state, PROXMOX_V7_VM_TOKEN)
    const outputNewTokenCount = countTokenOccurrences(state, PROXMOX_V8_VM_TOKEN)

    if (outputOldTokenCount !== 0) {
      return yield* new ProxmoxStateMigrationInvariantError({
        message: `Output still contains ${outputOldTokenCount} old token occurrences`,
        reason: "OldTokensRemain",
      })
    }

    if (outputNewTokenCount !== inputNewTokenCount + replacements) {
      return yield* new ProxmoxStateMigrationInvariantError({
        message: "New token count did not increase by the old token count",
        reason: "TokenCountMismatch",
      })
    }

    return { state, replacements, inputNewTokenCount, outputNewTokenCount }
  })

const isSystemErrorReason = (error: PlatformError, reason: "AlreadyExists" | "NotFound"): boolean =>
  error._tag === "SystemError" && error.reason === reason

const fileSystemError = (
  operation: ProxmoxStateMigrationFileSystemError["operation"],
  path: string,
  cause: PlatformError,
) =>
  new ProxmoxStateMigrationFileSystemError({
    cause,
    message: `${operation} failed for ${path}: ${cause.message}`,
    operation,
    path,
  })

const assertDistinctPaths = (
  inputPath: string,
  outputPath: string,
): Effect.Effect<
  void,
  ProxmoxStateMigrationPathError | ProxmoxStateMigrationFileSystemError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    if (inputPath === outputPath) {
      return yield* new ProxmoxStateMigrationPathError({
        inputPath,
        message: "Input and output paths must be different",
        outputPath,
        reason: "SamePath",
      })
    }

    const fileSystem = yield* FileSystem.FileSystem
    const inputRealPath = yield* fileSystem
      .realPath(inputPath)
      .pipe(Effect.mapError((cause) => fileSystemError("RealPath", inputPath, cause)))
    const outputRealPath = yield* fileSystem.realPath(outputPath).pipe(Effect.either)

    if (Either.isRight(outputRealPath)) {
      if (outputRealPath.right === inputRealPath) {
        return yield* new ProxmoxStateMigrationPathError({
          inputPath,
          message: "Input and output paths resolve to the same filesystem entry",
          outputPath,
          reason: "SameEntry",
        })
      }
      return
    }

    if (!isSystemErrorReason(outputRealPath.left, "NotFound")) {
      return yield* fileSystemError("RealPath", outputPath, outputRealPath.left)
    }
  })

const assertSafeStateFilenames = (
  inputPath: string,
  outputPath: string,
): Effect.Effect<void, ProxmoxStateMigrationPathError, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path

    if (
      !path.basename(inputPath).endsWith(PULUMI_STATE_FILE_SUFFIX) ||
      !path.basename(outputPath).endsWith(PULUMI_STATE_FILE_SUFFIX)
    ) {
      return yield* new ProxmoxStateMigrationPathError({
        inputPath,
        message: `Input and output filenames must end with ${PULUMI_STATE_FILE_SUFFIX}`,
        outputPath,
        reason: "UnsafeFilename",
      })
    }
  })

export const migrateProxmoxV7StateFile = (
  input: string,
  output: string,
): Effect.Effect<
  ProxmoxStateMigrationSummary,
  | ProxmoxStateMigrationPathError
  | ProxmoxStateMigrationJsonError
  | ProxmoxStateMigrationInvariantError
  | ProxmoxStateMigrationFileSystemError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const inputPath = path.resolve(input)
    const outputPath = path.resolve(output)

    yield* assertSafeStateFilenames(inputPath, outputPath)
    yield* assertDistinctPaths(inputPath, outputPath)

    const source = yield* fileSystem
      .readFileString(inputPath)
      .pipe(Effect.mapError((cause) => fileSystemError("Read", inputPath, cause)))
    const state = yield* Effect.try({
      try: () => JSON.parse(source) as JsonValue,
      catch: (cause) =>
        new ProxmoxStateMigrationJsonError({
          cause,
          inputPath,
          message: `Input is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    })
    const transformed = yield* transformProxmoxV7State(state)

    yield* fileSystem
      .writeFileString(outputPath, `${JSON.stringify(transformed.state, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(
        Effect.mapError((cause) =>
          isSystemErrorReason(cause, "AlreadyExists")
            ? new ProxmoxStateMigrationPathError({
                inputPath,
                message: `Output already exists; choose a new path: ${outputPath}`,
                outputPath,
                reason: "OutputExists",
              })
            : fileSystemError("Write", outputPath, cause),
        ),
      )

    return {
      replacements: transformed.replacements,
      inputNewTokenCount: transformed.inputNewTokenCount,
      outputNewTokenCount: transformed.outputNewTokenCount,
    }
  })

const usage =
  "Usage: node tools/migrations/proxmox-v7-to-v8-state.ts <input.pulumi-state.json> <output.pulumi-state.json>"

export const proxmoxStateMigrationProgram = (
  argv: readonly string[],
): Effect.Effect<void, ProxmoxStateMigrationError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const [input, output, ...extra] = argv

    if (input === undefined || output === undefined || extra.length > 0) {
      return yield* new ProxmoxStateMigrationUsageError({ message: usage })
    }

    const summary = yield* migrateProxmoxV7StateFile(input, output)
    yield* Console.log(JSON.stringify(summary, null, 2))
  })

const reportFailure = (cause: Cause.Cause<ProxmoxStateMigrationError>) => {
  if (Cause.isInterruptedOnly(cause)) {
    return Effect.void
  }

  return Option.match(Cause.failureOption(cause), {
    onNone: () => Console.error(Cause.pretty(cause)),
    onSome: (error) => Console.error(error.message),
  })
}

if (import.meta.main) {
  NodeRuntime.runMain(
    proxmoxStateMigrationProgram(process.argv.slice(2)).pipe(
      Effect.tapErrorCause(reportFailure),
      Effect.provide(NodeContext.layer),
    ),
    { disableErrorReporting: true },
  )
}
