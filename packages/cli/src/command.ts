import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"

import { resolveStackRegistry, type StackRegistry } from "@dsqr/core"

import { CliUsageError } from "./errors.ts"
import { runPulumi, type PulumiOperation } from "./pulumi.ts"

const targetArguments = Args.text({ name: "target" }).pipe(Args.repeated)
const yesOption = Options.boolean("yes")

const resolveTargets = Effect.fn("InfraCli.resolveTargets")(function* (
  registry: StackRegistry,
  requestedTargets: readonly string[],
) {
  const targets = requestedTargets.length === 0 ? ["default"] : requestedTargets
  const resolved: string[] = []

  for (const target of targets) {
    const group = registry.groups[target]
    if (group) {
      resolved.push(...group)
    } else if (registry.stacks[target]) {
      resolved.push(target)
    } else {
      return yield* new CliUsageError({
        message: `Unknown stack or group "${target}".`,
      })
    }
  }

  return [...new Set(resolved)]
})

const runOperation = Effect.fn("InfraCli.runOperation")(function* (
  registry: StackRegistry,
  options: {
    readonly operation: PulumiOperation
    readonly stage: string
    readonly targets: readonly string[]
    readonly yes: boolean
  },
) {
  if (options.operation === "destroy" && !options.yes) {
    return yield* new CliUsageError({ message: "destroy requires --yes." })
  }

  const resolvedRegistry = yield* resolveStackRegistry(registry)
  const selected = yield* resolveTargets(registry, options.targets)

  yield* Console.log(`${options.operation}: ${selected.join(", ")} (${options.stage})`)
  yield* Effect.forEach(
    selected,
    (stackName) =>
      runPulumi({
        operation: options.operation,
        stack: resolvedRegistry.stacks[stackName]!,
        stage: options.stage,
        yes: options.yes,
      }),
    { concurrency: 1, discard: true },
  )
})

const makeOperationCommand = (
  registry: StackRegistry,
  defaultStage: string,
  operation: PulumiOperation,
) =>
  Command.make(
    operation,
    {
      stage: Options.text("stage").pipe(Options.withDefault(defaultStage)),
      targets: targetArguments,
      yes: yesOption,
    },
    ({ stage, targets, yes }) =>
      runOperation(registry, {
        operation,
        stage,
        targets,
        yes,
      }),
  )

export const makeInfraCommand = (registry: StackRegistry, defaultStage: string) => {
  const validate = Command.make("validate", {}, () =>
    Effect.gen(function* () {
      const resolved = yield* resolveStackRegistry(registry)
      yield* Console.log(
        `Validated ${Object.keys(resolved.stacks).length} infrastructure projects and ${Object.keys(resolved.groups).length} groups.`,
      )
    }),
  )

  return Command.make("infra").pipe(
    Command.withDescription("Preview and manage the registered Pulumi infrastructure stacks."),
    Command.withSubcommands([
      validate,
      makeOperationCommand(registry, defaultStage, "preview"),
      makeOperationCommand(registry, defaultStage, "drift"),
      makeOperationCommand(registry, defaultStage, "up"),
      makeOperationCommand(registry, defaultStage, "destroy"),
    ]),
  )
}
