import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse } from "yaml"
import { Effect } from "effect"
import { NodeContext } from "@effect/platform-node"
import { command, commandBytes } from "../packages/gitops/src/release-runtime.ts"
import {
  currentRevision,
  releaseApp,
  releaseApps,
  updateRelease,
  validateImages,
  validateRun,
} from "../packages/gitops/src/releases.ts"

const app = "dotdev-web"
const config = releaseApps[app]
const sha = "a".repeat(40)
const digest = `sha256:${"b".repeat(64)}`
const run = {
  repository: { full_name: config.repository },
  head_repository: { full_name: config.repository },
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "master",
  head_sha: sha,
  status: "completed",
  conclusion: "success",
}
const image = {
  image: config.image,
  commit: sha,
  digest,
  ref: `${config.image}@${digest}`,
  platforms: { "linux/amd64": digest, "linux/arm64": digest },
}

test("release process boundary preserves binary output and sends stdin without a shell", async () => {
  const bytes = await Effect.runPromise(
    commandBytes(process.execPath, ["-e", "process.stdout.write(Buffer.from([0, 255, 128]))"]).pipe(
      Effect.provide(NodeContext.layer),
    ),
  )
  assert.deepEqual([...bytes], [0, 255, 128])
  const input = "$(do-not-execute); 'release'\n"
  const output = await Effect.runPromise(
    command(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], input).pipe(
      Effect.provide(NodeContext.layer),
    ),
  )
  assert.equal(output, input)
})

test("release process boundary rejects failed commands", async () => {
  await assert.rejects(
    Effect.runPromise(
      command(process.execPath, ["-e", "process.stderr.write('denied'); process.exit(7)"]).pipe(
        Effect.provide(NodeContext.layer),
      ),
    ),
    /failed \(7\): denied/,
  )
})

test("release process boundary bounds downloaded data", async () => {
  await assert.rejects(
    Effect.runPromise(
      commandBytes(process.execPath, [
        "-e",
        "process.stdout.write(Buffer.alloc(5 * 1024 * 1024))",
      ]).pipe(Effect.provide(NodeContext.layer)),
    ),
    /output exceeded safety limit/,
  )
})

test("release onboarding is explicit, not an arbitrary repo or path input", () => {
  assert.equal(releaseApp(app), app)
  for (const value of ["../dotdev-web", "dotdev-studio", "constructor", "__proto__", ""])
    assert.throws(() => releaseApp(value))
})

test("promotion accepts only successful trusted production CI at the source head", () => {
  assert.equal(validateRun(app, run, sha), sha)
  assert.equal(validateRun(app, { ...run, event: "workflow_dispatch" }, sha), sha)
  for (const patch of [
    { repository: { full_name: "attacker/project" } },
    { head_repository: { full_name: "attacker/dsqr-dotdev" } },
    { path: ".github/workflows/other.yml" },
    { event: "pull_request" },
    { head_branch: "feature" },
    { head_sha: "c".repeat(40) },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
  ])
    assert.throws(() => validateRun(app, { ...run, ...patch }, sha), JSON.stringify(patch))
})

test("release artifact binds the immutable multi-platform image to its source", () => {
  assert.equal(validateImages(app, { [app]: image }, sha), digest)
  for (const patch of [
    { image: "ghcr.io/attacker/dotdev-web" },
    { commit: "c".repeat(40) },
    { digest: "master" },
    { ref: `${config.image}:master` },
    { platforms: { "linux/amd64": digest } },
    { platforms: { "linux/amd64": "latest", "linux/arm64": digest } },
  ])
    assert.throws(() => validateImages(app, { [app]: { ...image, ...patch } }, sha))
  assert.throws(() => validateImages(app, {}, sha))
})

test("promotion changes only the app/chart revision and image digest", () => {
  const sources = {
    applicationSet: readFileSync(config.applicationSet, "utf8"),
    values: readFileSync(config.values, "utf8"),
  }
  assert.match(currentRevision(sources.applicationSet, app), /^[a-f0-9]{40}$/)
  const result = updateRelease(app, sources, sha, digest, "12345")
  const oldSet = parse(sources.applicationSet)
  const nextSet = parse(result.applicationSet)
  oldSet.spec.generators[0].matrix.generators[1].list.elements[0].appRevision = sha
  assert.deepEqual(nextSet, oldSet)
  assert.equal(nextSet.spec.templatePatch, parse(sources.applicationSet).spec.templatePatch)
  const oldValues = parse(sources.values)
  oldValues.image.digest = digest
  assert.deepEqual(parse(result.values), oldValues)
  assert.match(result.values, /# CI 12345, 0xdsqr\/dsqr-dotdev commit a{40}\./)
  assert.deepEqual(updateRelease(app, result, sha, digest, "12345"), result)
  for (const bad of ["master", "../x", "a".repeat(39)])
    assert.throws(() => updateRelease(app, sources, bad, digest, "12345"))
  assert.throws(() => updateRelease(app, sources, sha, digest, "123\ninject=true"))
  assert.throws(() =>
    currentRevision(sources.applicationSet.replace("name: dotdev-web", "name: unknown"), app),
  )
  assert.throws(() => currentRevision(`${sources.applicationSet}\nspec: {}\n`, app))
})

test("release workflow is disabled until explicitly configured and never deploys", () => {
  const workflow = readFileSync(".github/workflows/promote-app.yml", "utf8")
  assert.match(workflow, /RELEASE_PROMOTION_ENABLED == 'true'/)
  assert.match(workflow, /permission-actions: read/)
  assert.match(workflow, /repositories: infrastructure/)
  assert.match(workflow, /permission-pull-requests: write/)
  assert.doesNotMatch(
    workflow,
    /secrets: inherit|pull_request_target|kubectl|argocd .*sync|pr merge/,
  )
  const matrix = parse(workflow).jobs.promote.strategy.matrix.include
  assert.deepEqual(
    matrix.map((entry: { app: string }) => entry.app).sort(),
    Object.keys(releaseApps).sort(),
  )
  assert.equal(matrix[0]["source-repository"], config.repository.split("/")[1])
})
