import { Data } from "effect"

export class CliUsageError extends Data.TaggedError("CliUsageError")<{
  readonly message: string
}> {}

export class PulumiCommandError extends Data.TaggedError("PulumiCommandError")<{
  readonly cause?: unknown
  readonly command: string
  readonly exitCode?: number
  readonly message: string
  readonly stackName: string
}> {}
