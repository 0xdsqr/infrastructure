import { Data } from "effect"

export class StackDiscoveryError extends Data.TaggedError("StackDiscoveryError")<{
  readonly cause: unknown
  readonly directory: string
  readonly message: string
}> {}

export class StackConfigError extends Data.TaggedError("StackConfigError")<{
  readonly message: string
}> {}
