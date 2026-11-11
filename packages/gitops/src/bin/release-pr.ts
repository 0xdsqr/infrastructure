#!/usr/bin/env node

import assert from "node:assert/strict"
import { Cause, Config, Console, Effect } from "effect"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import {
  currentLockRevision,
  currentRevision,
  object,
  releaseApp,
  releaseApps,
  shaPattern,
  updateRelease,
  validateLockUpdate,
} from "../releases.ts"
import { parse } from "yaml"

const repository = "dsqr-labs/deployments"
import { FileSystem } from "@effect/platform"
import { api, command } from "../release-runtime.ts"

const publish = Effect.fn("GitOps.releasePr")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const app = releaseApp(yield* Config.string("RELEASE_APP"))
  const commit = yield* Config.string("RELEASE_COMMIT")
  const run = yield* Config.string("RELEASE_RUN")
  assert.match(commit, shaPattern)
  assert.match(run, /^[1-9][0-9]*$/)
  assert.equal(
    yield* Config.string("GITHUB_REPOSITORY"),
    repository,
    "Run only in the deployments workflow",
  )
  assert.equal(
    yield* Config.string("GITHUB_REF"),
    "refs/heads/master",
    "Run only from deployments master",
  )
  const config = releaseApps[app]
  const paths = [config.flakeLock, config.release, config.values].sort()
  const changed = (yield* command("git", ["diff", "--name-only", "HEAD"])).trim().split("\n").sort()
  assert.deepEqual(changed, paths, "Release PR must change exactly the two registered pin files")
  assert.equal(
    (yield* command("git", ["ls-files", "--others", "--exclude-standard"])).trim(),
    "",
    "Unexpected untracked files",
  )
  const release = yield* fileSystem.readFileString(config.release)
  assert.equal(currentRevision(release, app), commit)
  const values = yield* fileSystem.readFileString(config.values)
  const digest = object(object(parse(values)).image).digest
  assert.equal(typeof digest, "string")
  const lock = yield* fileSystem.readFileString(config.flakeLock)
  assert.equal(currentLockRevision(lock, app), commit)
  const previousLock = yield* command("git", ["show", `HEAD:${config.flakeLock}`])
  validateLockUpdate(previousLock, lock, app, commit)
  const expected = updateRelease(
    app,
    {
      release: yield* command("git", ["show", `HEAD:${config.release}`]),
      values: yield* command("git", ["show", `HEAD:${config.values}`]),
    },
    commit,
    digest as string,
    run,
  )
  assert.equal(release, expected.release, "Unexpected release pin changes")
  assert.equal(values, expected.values, "Unexpected production setting changes")
  const prefix = `release/${app}-`
  const open = JSON.parse(
    yield* command("gh", [
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "headRefName",
    ]),
  ) as unknown[]
  if (open.some((pr) => String(object(pr).headRefName).startsWith(prefix))) {
    yield* Console.log(
      "A release PR is already awaiting review for this app; leaving it untouched.",
    )
    return
  }
  const base = (yield* command("git", ["rev-parse", "HEAD"])).trim()
  assert.equal(
    object(object(yield* api(`repos/${repository}/git/ref/heads/master`)).object).sha,
    base,
    "Deployments master moved; retry on the new base",
  )
  const branch = `${prefix}${run}`
  // Never force-push or reuse an existing branch. Retries fail safely if interrupted.
  yield* command(
    "gh",
    ["api", `repos/${repository}/git/refs`, "--method", "POST", "--input", "-"],
    JSON.stringify({ ref: `refs/heads/${branch}`, sha: base }),
  )
  const additions = yield* Effect.forEach(
    paths,
    Effect.fn("GitOps.releaseAddition")(function* (path) {
      const contents = yield* fileSystem.readFile(path)
      return { path, contents: Buffer.from(contents).toString("base64") }
    }),
  )
  const message = `release(${app}): promote ${commit.slice(0, 12)}`
  // GitHub creates the commit (no workstation GPG key in CI).
  const response = JSON.parse(
    yield* command(
      "gh",
      ["api", "graphql", "--input", "-"],
      JSON.stringify({
        query:
          "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
        variables: {
          input: {
            branch: { repositoryNameWithOwner: repository, branchName: branch },
            expectedHeadOid: base,
            message: { headline: message },
            fileChanges: { additions },
          },
        },
      }),
    ),
  )
  assert.equal(object(response).errors, undefined, "GitHub could not create release commit")
  const body = [
    `Promote **${app}** to \`${commit}\`.`,
    `Source CI: https://github.com/${config.repository}/actions/runs/${run}`,
    "Verified successful default-branch CI, immutable multi-architecture image, source-bound provenance, forward-only source ancestry, and a matching source lock.",
    "Review rendered production manifests and any database compatibility requirements before merging. This PR does not apply migrations, change credentials, or automatically merge itself.",
    "Argo reconciles after merge only once this application's auto-sync has been explicitly enabled. Revert the release pins to roll back the image/chart; database changes are separate.",
  ].join("\n\n")
  yield* Console.log(
    (yield* command("gh", [
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      "master",
      "--head",
      branch,
      "--title",
      message,
      "--body",
      body,
    ])).trim(),
  )
})

publish().pipe(
  Effect.provide(NodeContext.layer),
  Effect.catchAllCause((cause) =>
    Console.error(Cause.pretty(cause)).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
    ),
  ),
  NodeRuntime.runMain,
)
