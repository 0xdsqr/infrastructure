import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import test from "node:test"
import { parse } from "yaml"
import { Effect } from "effect"
import { NodeContext } from "@effect/platform-node"
import { command, commandBytes } from "../packages/gitops/src/release-runtime.ts"
import {
  currentLockRevision,
  currentRevision,
  releaseApp,
  releaseApps,
  updateRelease,
  validateLockUpdate,
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
const previousSha = "c".repeat(40)
const previousDigest = `sha256:${"d".repeat(64)}`
const releaseSource = `# Deployment selection only.\nsourceRevision: ${previousSha}\n`
const valuesSource = `# CI 1, ${config.repository} commit ${previousSha}.\nimage:\n  digest: ${previousDigest}\nreplicaCount: 1\n`
const lock = (revision: string) =>
  `${JSON.stringify(
    {
      nodes: {
        dotdev: {
          flake: false,
          locked: {
            lastModified: 1,
            narHash: `sha256-${"A".repeat(43)}=`,
            owner: "0xdsqr",
            repo: "dsqr-dotdev",
            rev: revision,
            type: "github",
          },
          original: { owner: "0xdsqr", repo: "dsqr-dotdev", type: "github" },
        },
        root: { inputs: { dotdev: "dotdev" } },
      },
      root: "root",
      version: 7,
    },
    null,
    2,
  )}\n`

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
    release: releaseSource,
    values: valuesSource,
  }
  assert.equal(currentRevision(sources.release, app), previousSha)
  const result = updateRelease(app, sources, sha, digest, "12345")
  assert.deepEqual(parse(result.release), { sourceRevision: sha })
  const oldValues = parse(sources.values)
  oldValues.image.digest = digest
  assert.deepEqual(parse(result.values), oldValues)
  assert.match(result.values, /# CI 12345, 0xdsqr\/dsqr-dotdev commit a{40}\./)
  assert.deepEqual(updateRelease(app, result, sha, digest, "12345"), result)
  for (const bad of ["master", "../x", "a".repeat(39)])
    assert.throws(() => updateRelease(app, sources, bad, digest, "12345"))
  assert.throws(() => updateRelease(app, sources, sha, digest, "123\ninject=true"))
  assert.throws(() => currentRevision(`sourceRevision: ${previousSha}\nproject: admin\n`, app))
  assert.throws(() => currentRevision(`sourceRevision: master\n`, app))
  assert.throws(() => currentRevision(`${sources.release}\nsourceRevision: ${sha}\n`, app))
})

test("promotion source lock changes only the registered input to the verified commit", () => {
  const before = lock(previousSha)
  const after = lock(sha)
  assert.equal(currentLockRevision(before, app), previousSha)
  validateLockUpdate(before, after, app, sha)
  assert.throws(() => validateLockUpdate(before, after, app, "e".repeat(40)))
  const unrelated = JSON.parse(after)
  unrelated.version = 8
  assert.throws(() => validateLockUpdate(before, JSON.stringify(unrelated), app, sha))
  const redirected = JSON.parse(after)
  redirected.nodes.dotdev.original.owner = "attacker"
  assert.throws(() => currentLockRevision(JSON.stringify(redirected), app))
})

test("public infrastructure contains generic promotion tooling, not deployment automation", () => {
  assert.equal(existsSync(".github/workflows/promote-app.yml"), false)
  assert.equal(config.release, "apps/dotdev-web/environments/production/release.yaml")
  assert.equal(config.values, "apps/dotdev-web/environments/production/values.yaml")
  assert.equal(config.flakeLock, "flake.lock")
  assert.equal(config.flakeInput, "dotdev")
  assert.equal(config.repository, "0xdsqr/dsqr-dotdev")
})
