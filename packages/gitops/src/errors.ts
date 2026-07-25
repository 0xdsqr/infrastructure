import { Data } from "effect"

export class GitOpsUsageError extends Data.TaggedError("GitOpsUsageError")<{
  readonly message: string
}> {}

export class GitOpsFileSystemError extends Data.TaggedError("GitOpsFileSystemError")<{
  readonly cause: unknown
  readonly message: string
  readonly path: string
}> {}

export class GitOpsYamlError extends Data.TaggedError("GitOpsYamlError")<{
  readonly cause: unknown
  readonly message: string
  readonly path: string
}> {}

export class GitOpsValidationError extends Data.TaggedError("GitOpsValidationError")<{
  readonly message: string
  readonly path?: string
}> {}

export class GitOpsCommandError extends Data.TaggedError("GitOpsCommandError")<{
  readonly args: readonly string[]
  readonly cause?: unknown
  readonly command: string
  readonly exitCode?: number
  readonly message: string
  readonly stderr?: string
}> {}

export type GitOpsError =
  | GitOpsUsageError
  | GitOpsFileSystemError
  | GitOpsYamlError
  | GitOpsValidationError
  | GitOpsCommandError
