import { Console, Effect } from "effect"

import type { GitOpsError } from "./errors.ts"

export const formatGitOpsError = (error: GitOpsError): string =>
  error._tag === "GitOpsCommandError" && error.stderr
    ? `${error.message}\n${error.stderr}`
    : error.message

export const runGitOpsMain = (
  program: Effect.Effect<void, GitOpsError, never>,
): Effect.Effect<void> =>
  program.pipe(
    Effect.catchAll((error) =>
      Console.error(formatGitOpsError(error)).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            process.exitCode = error._tag === "GitOpsUsageError" ? 2 : 1
          }),
        ),
      ),
    ),
  )
