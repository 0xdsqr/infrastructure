import * as pulumi from "@pulumi/pulumi"
import type {
  MockCallArgs,
  MockCallResult,
  MockResourceArgs,
  MockResourceResult,
} from "@pulumi/pulumi/runtime"

export type CapturedResource = pulumi.ResourceTransformationArgs

export type PulumiMockProgramOptions<Result> = {
  readonly program: () => Result
  readonly outputs?: (result: Result) => Record<string, unknown>
  readonly call?: (args: MockCallArgs) => MockCallResult | Promise<MockCallResult>
  readonly newResource?: (
    args: MockResourceArgs,
  ) => Partial<MockResourceResult["state"]> | Promise<Partial<MockResourceResult["state"]>>
  readonly newResourceId?: (
    args: MockResourceArgs,
  ) => string | undefined | Promise<string | undefined>
  readonly project?: string
  readonly stack?: string
}

export async function runPulumiMockProgram<Result>(options: PulumiMockProgramOptions<Result>) {
  const resources: Array<MockResourceArgs> = []
  const calls: Array<MockCallArgs> = []
  const captured: Array<CapturedResource> = []

  await pulumi.runtime.setMocks(
    {
      call: async (args) => {
        calls.push(args)
        return options.call ? options.call(args) : args.inputs
      },
      newResource: async (args) => {
        resources.push(args)
        const state = options.newResource ? await options.newResource(args) : {}
        const id = options.newResourceId
          ? await options.newResourceId(args)
          : args.custom
            ? `${args.name}-id`
            : undefined

        return {
          id,
          state: {
            ...args.inputs,
            ...state,
          },
        }
      },
    },
    options.project ?? "infrastructure",
    options.stack ?? "dev",
    true,
  )

  let result: Result | undefined

  await pulumi.runtime.runInPulumiStack(async () => {
    pulumi.runtime.registerStackTransformation((args) => {
      captured.push(args)
      return undefined
    })

    result = options.program()
    return options.outputs?.(result) ?? {}
  })

  return {
    calls,
    captured,
    resources,
    result: result!,
  }
}

export const resolveOutput = <Value>(output: pulumi.Output<Value>) =>
  (
    output as unknown as {
      promise(): Promise<Value>
    }
  ).promise()

export const byName = <Value extends { readonly name: string }>(
  values: ReadonlyArray<Value>,
  name: string,
) => {
  const value = values.find((candidate) => candidate.name === name)

  if (!value) {
    throw new Error(`Missing captured Pulumi resource "${name}".`)
  }

  return value
}
