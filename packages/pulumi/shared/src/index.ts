import { Cause, Data, Effect, Exit } from "effect"

export type PulumiConfigReader<Secret = unknown> = {
  get(name: string): string | undefined
  getBoolean(name: string): boolean | undefined
  getSecret(name: string): Secret | undefined
}

export class MissingPulumiConfigError extends Data.TaggedError("MissingPulumiConfigError")<{
  readonly field: string
  readonly expected: ReadonlyArray<string>
  readonly message: string
}> {}

export class PulumiResourceConfigError extends Data.TaggedError("PulumiResourceConfigError")<{
  readonly resource: string
  readonly message: string
}> {}

export class PulumiResourceError extends Data.TaggedError("PulumiResourceError")<{
  readonly cause: unknown
  readonly resource: string
  readonly message: string
}> {}

export type ResourceOptions = {
  readonly parent?: unknown
  readonly provider?: unknown
  readonly dependsOn?: unknown
}

export type TransformResult<Args extends object, Options extends object> = {
  readonly args?: Partial<Args> | undefined
  readonly options?: Partial<Options> | undefined
}

export type Transform<Args extends object, Options extends object = ResourceOptions> =
  | Partial<Args>
  | ((
      args: Readonly<Args>,
      options: Readonly<Options>,
      name: string,
    ) => TransformResult<Args, Options> | undefined)

export function firstDefined(...values: ReadonlyArray<string | undefined>) {
  return values.find((value) => value !== undefined && value.length > 0)
}

export function hasValue<T>(value: T | undefined): value is T {
  return value !== undefined && value !== ""
}

export function requireConfigValueEffect<T>(
  value: T | undefined,
  field: string,
  expected: ReadonlyArray<string>,
): Effect.Effect<T, MissingPulumiConfigError> {
  return hasValue(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new MissingPulumiConfigError({
          field,
          expected,
          message: `Missing ${field}; configure one of: ${expected.join(", ")}.`,
        }),
      )
}

export function requireResourceConfigEffect(
  condition: boolean,
  resource: string,
  message: string,
): Effect.Effect<void, PulumiResourceConfigError> {
  return condition ? Effect.void : Effect.fail(new PulumiResourceConfigError({ resource, message }))
}

/**
 * Pulumi evaluates a TypeScript stack by importing its module and expects
 * resource registration to finish synchronously. Reusable packages return
 * Effects; only a stack entrypoint should cross this boundary.
 */
export function runPulumiProgram<A, E>(effect: Effect.Effect<A, E, never>): A {
  const exit = Effect.runSyncExit(effect)

  if (Exit.isSuccess(exit)) {
    return exit.value
  }

  throw Cause.squash(exit.cause)
}

/**
 * Captures synchronous failures thrown while a Pulumi resource or invoke is
 * registered. Provider RPCs, Output evaluation, and engine lifecycle failures
 * remain owned and reported by the Pulumi engine.
 */
export const registerPulumiResource = Effect.fn("Pulumi.registerResource")(
  <A>(resource: string, register: () => A): Effect.Effect<A, PulumiResourceError> =>
    Effect.try({
      try: register,
      catch: (cause) =>
        new PulumiResourceError({
          cause,
          resource,
          message: `Unable to register Pulumi resource "${resource}".`,
        }),
    }),
)

export function transformResourceArgs<
  Args extends object,
  Options extends object = ResourceOptions,
>(transform: Transform<Args, Options> | undefined, name: string, args: Args, options: Options) {
  if (typeof transform === "function") {
    const transformed = transform(args, options, name)
    return [
      name,
      { ...args, ...transformed?.args },
      { ...options, ...transformed?.options },
    ] as const
  }

  return [name, { ...args, ...transform }, options] as const
}
