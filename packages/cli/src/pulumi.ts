import * as PlatformCommand from "@effect/platform/Command"
import { Console, Effect } from "effect"

import type { ResolvedStack } from "@dsqr/core"

import { PulumiCommandError } from "./errors.ts"

export type PulumiOperation = "destroy" | "drift" | "preview" | "up"

const pulumiArguments = (
  operation: PulumiOperation,
  stage: string,
  yes: boolean,
): readonly string[] => {
  const confirmation = yes ? ["--yes"] : []

  switch (operation) {
    case "preview":
      return ["preview", "--stack", stage]
    case "drift":
      return ["refresh", "--preview-only", "--expect-no-changes", "--stack", stage]
    case "up":
      return ["up", "--stack", stage, ...confirmation]
    case "destroy":
      return ["destroy", "--stack", stage, ...confirmation]
  }
}

export const runPulumi = Effect.fn("PulumiCli.run")(function* (options: {
  readonly operation: PulumiOperation
  readonly stack: ResolvedStack
  readonly stage: string
  readonly yes: boolean
}) {
  yield* Console.log(`\n==> ${options.operation} ${options.stack.name}`)

  const command = PlatformCommand.make(
    "pulumi",
    ...pulumiArguments(options.operation, options.stage, options.yes),
  ).pipe(
    PlatformCommand.workingDirectory(options.stack.directory),
    PlatformCommand.env({
      PULUMI_DISABLE_AUTOMATIC_PLUGIN_ACQUISITION: "true",
      PULUMI_SKIP_UPDATE_CHECK: "true",
    }),
    PlatformCommand.stdin("inherit"),
    PlatformCommand.stdout("inherit"),
    PlatformCommand.stderr("inherit"),
  )

  const exitCode = yield* PlatformCommand.exitCode(command).pipe(
    Effect.mapError(
      (cause) =>
        new PulumiCommandError({
          cause,
          command: options.operation,
          message: `Unable to execute ${options.operation} for "${options.stack.name}".`,
          stackName: options.stack.name,
        }),
    ),
  )

  if (exitCode !== 0) {
    return yield* new PulumiCommandError({
      command: options.operation,
      exitCode,
      message: `${options.operation} ${options.stack.name} failed with exit code ${exitCode}.`,
      stackName: options.stack.name,
    })
  }
})
