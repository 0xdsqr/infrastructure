import { Command } from "@effect/platform"
import { Effect, Stream } from "effect"

// No shell expansion; bound process time and both output streams, including ZIP data.
export const commandBytes = Effect.fn("GitOps.releaseCommand")(function* (
  name: string,
  args: string[],
  input?: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Command.start(
        Command.make(name, ...args).pipe(
          Command.stdin(
            input === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(input)),
          ),
        ),
      )
      const collect = (stream: typeof child.stdout) =>
        stream.pipe(
          Stream.runFoldEffect(Buffer.alloc(0), (bytes, chunk) =>
            bytes.length + chunk.length <= 4 * 1024 * 1024
              ? Effect.succeed(Buffer.concat([bytes, chunk]))
              : Effect.fail(new Error(`${name} output exceeded safety limit`)),
          ),
        )
      const result = yield* Effect.all(
        { code: child.exitCode, stdout: collect(child.stdout), stderr: collect(child.stderr) },
        { concurrency: "unbounded" },
      )
      if (result.code !== 0)
        return yield* Effect.fail(
          new Error(`${name} failed (${result.code}): ${result.stderr.toString("utf8").trim()}`),
        )
      return result.stdout
    }).pipe(Effect.timeout("120 seconds")),
  )
})

export const command = (name: string, args: string[], input?: string) =>
  commandBytes(name, args, input).pipe(Effect.map((bytes) => bytes.toString("utf8")))

export const api = (path: string) =>
  command("gh", ["api", path]).pipe(
    Effect.flatMap((output) => Effect.try(() => JSON.parse(output) as unknown)),
  )
