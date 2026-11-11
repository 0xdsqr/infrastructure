#!/usr/bin/env node

import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { parse, parseAllDocuments } from "yaml"
import { Cause, Config, Console, Effect } from "effect"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import {
  currentRevision,
  object,
  releaseApp,
  releaseApps,
  updateRelease,
  validateImages,
  validateRun,
} from "../releases.ts"

import { FileSystem } from "@effect/platform"
import { api, command, commandBytes } from "../release-runtime.ts"

const promote = Effect.fn("GitOps.promote")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const outputPath = yield* Config.string("GITHUB_OUTPUT").pipe(Config.withDefault(""))
  const args = process.argv.slice(2)
  if (args.includes("--help")) {
    yield* Console.log(
      "gitops-promote --app NAME [--run ID] [--write]\nDefault: verify only. --write changes two local pins; never pushes, merges or deploys.",
    )
    return
  }
  let name = ""
  let runId = ""
  let write = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--app") name = args[++i] ?? ""
    else if (args[i] === "--run") runId = args[++i] ?? ""
    else if (args[i] === "--write") write = true
    else throw new Error("Unknown promotion argument")
  }
  const app = releaseApp(name)
  const config = releaseApps[app]
  const base = `repos/${config.repository}`
  if (runId) assert.match(runId, /^[1-9][0-9]*$/)
  if (write) {
    assert.equal(
      (yield* command("git", ["status", "--porcelain"])).trim(),
      "",
      "Promotion needs a clean checkout",
    )
    assert.equal(
      (yield* command("git", ["rev-parse", "HEAD"])).trim(),
      (yield* command("git", ["rev-parse", "origin/master"])).trim(),
      "Checkout must match infrastructure master",
    )
  }
  const head = object(yield* api(`${base}/commits/${config.branch}`)).sha
  assert.equal(typeof head, "string")
  if (!runId) {
    const runs = object(
      yield* api(
        `${base}/actions/workflows/${config.workflow}/runs?branch=${config.branch}&status=success&per_page=50`,
      ),
    ).workflow_runs
    assert.ok(Array.isArray(runs))
    const candidate = runs
      .map(object)
      .find(
        (run) =>
          run.head_sha === head && (run.event === "push" || run.event === "workflow_dispatch"),
      )
    if (!candidate) {
      yield* Console.log("No successful release for the current source head; nothing promoted.")
      return
    }
    runId = String(candidate.id)
    assert.match(runId, /^[1-9][0-9]*$/)
  }
  const commit = validateRun(app, yield* api(`${base}/actions/runs/${runId}`), head as string)
  const sources = {
    applicationSet: yield* fileSystem.readFileString(config.applicationSet),
    values: yield* fileSystem.readFileString(config.values),
  }
  const previous = currentRevision(sources.applicationSet, app)
  const comparison = object(yield* api(`${base}/compare/${previous}...${commit}`))
  assert.ok(
    comparison.status === "ahead" || comparison.status === "identical",
    "Refusing an automatic rollback or divergent release",
  )
  const artifacts = object(
    yield* api(`${base}/actions/runs/${runId}/artifacts?per_page=100`),
  ).artifacts
  assert.ok(Array.isArray(artifacts))
  const matches = artifacts
    .map(object)
    .filter((artifact) => artifact.name === config.artifact && artifact.expired === false)
  assert.equal(matches.length, 1, "Expected one unexpired image-digests artifact")
  const artifact = matches[0]!
  assert.ok(
    typeof artifact.size_in_bytes === "number" && artifact.size_in_bytes <= 1024 * 1024,
    "Release artifact is unexpectedly large",
  )
  assert.ok(typeof artifact.id === "number" && Number.isSafeInteger(artifact.id) && artifact.id > 0)
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "gitops-release-" })
  let digest: string
  {
    const archive = yield* commandBytes("gh", [
      "api",
      `${base}/actions/artifacts/${artifact.id}/zip`,
    ])
    const archivePath = join(directory, "artifact.zip")
    yield* fileSystem.writeFile(archivePath, archive, { mode: 0o600, flag: "wx" })
    assert.equal(
      (yield* command("unzip", ["-Z1", archivePath])).trim(),
      "images.json",
      "Unexpected archive contents",
    )
    // Read the only permitted member to stdout, never extract paths from an artifact.
    digest = validateImages(
      app,
      JSON.parse(yield* command("unzip", ["-p", archivePath, "images.json"])),
      commit,
    )
  }
  yield* command("gh", [
    "attestation",
    "verify",
    `oci://${config.image}@${digest}`,
    "--repo",
    config.repository,
    "--signer-workflow",
    `${config.repository}/.github/workflows/${config.workflow}`,
    "--source-ref",
    `refs/heads/${config.branch}`,
    "--source-digest",
    commit,
    "--deny-self-hosted-runners",
  ])
  // Catch a newer source push while verification was in progress.
  assert.equal(
    object(yield* api(`${base}/commits/${config.branch}`)).sha,
    commit,
    "Source changed during verification; retry",
  )
  if (previous === commit) {
    assert.equal(
      object(object(parse(sources.values)).image).digest,
      digest,
      "Same source commit has a different image; review rebuild explicitly",
    )
    yield* Console.log("Release already selected; no change.")
    return
  }
  const updated = updateRelease(app, sources, commit, digest, runId)
  const chartDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "gitops-chart-" })
  {
    const tree = object(yield* api(`${base}/git/trees/${commit}?recursive=1`))
    assert.equal(tree.truncated, false, "Incomplete source tree")
    assert.ok(Array.isArray(tree.tree))
    const files = tree.tree
      .map(object)
      .filter(
        (entry) =>
          typeof entry.path === "string" &&
          entry.path.startsWith(`${config.chart}/`) &&
          entry.type !== "tree",
      )
    assert.ok(files.length > 0 && files.length <= 100, "Unexpected chart file count")
    let totalSize = 0
    for (const file of files) {
      assert.equal(file.mode, "100644", "Chart must contain only regular, non-executable files")
      const path = (file.path as string).slice(config.chart.length + 1)
      assert.ok(
        path
          .split("/")
          .every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== ".."),
        "Unsafe chart path",
      )
      assert.ok(typeof file.size === "number" && file.size <= 512 * 1024, "Chart file is too large")
      totalSize += file.size
      assert.ok(totalSize <= 4 * 1024 * 1024, "Chart is too large")
      assert.match(String(file.sha), /^[a-f0-9]{40}$/)
      const blob = object(yield* api(`${base}/git/blobs/${file.sha}`))
      assert.equal(blob.encoding, "base64")
      assert.equal(typeof blob.content, "string")
      const destination = join(chartDirectory, "chart", path)
      yield* fileSystem.makeDirectory(dirname(destination), { recursive: true })
      yield* fileSystem.writeFile(destination, Buffer.from(blob.content as string, "base64"), {
        flag: "wx",
      })
    }
    const chartPath = join(chartDirectory, "chart")
    const valuesPath = join(chartDirectory, "production.yaml")
    yield* fileSystem.writeFileString(valuesPath, updated.values, { flag: "wx" })
    const flags = [
      "--kube-version",
      config.kubeVersion,
      "--namespace",
      config.namespace,
      "-f",
      join(chartPath, config.profile),
      "-f",
      valuesPath,
    ]
    yield* command("helm", ["lint", "--strict", chartPath, ...flags])
    const manifests = parseAllDocuments(
      yield* command("helm", ["template", app, chartPath, ...flags]),
    ).map((doc) => {
      assert.equal(doc.errors.length, 0, "Chart emitted invalid YAML")
      return object(doc.toJS())
    })
    const deployment = manifests.filter(
      (manifest) => manifest.kind === "Deployment" && object(manifest.metadata).name === app,
    )
    assert.equal(deployment.length, 1, "Expected one application Deployment")
    assert.equal(object(deployment[0]!.metadata).namespace, config.namespace)
    const pod = object(object(object(deployment[0]!.spec).template).spec)
    assert.ok(Array.isArray(pod.containers))
    const containers = pod.containers.map(object).filter((container) => container.name === "app")
    assert.equal(containers.length, 1)
    assert.equal(
      containers[0]!.image,
      `${config.image}@${digest}`,
      "Rendered image differs from verified release",
    )
    assert.equal(pod.automountServiceAccountToken, false)
    assert.equal(object(pod.securityContext).runAsNonRoot, true)
    assert.equal(object(containers[0]!.securityContext).readOnlyRootFilesystem, true)
  }
  assert.equal(
    object(yield* api(`${base}/commits/${config.branch}`)).sha,
    commit,
    "Source changed during chart validation; retry",
  )
  if (write) {
    yield* fileSystem.writeFileString(config.applicationSet, updated.applicationSet)
    yield* fileSystem.writeFileString(config.values, updated.values)
    if (outputPath)
      yield* fileSystem.writeFileString(
        outputPath,
        `changed=true\ncommit=${commit}\nrun=${runId}\napp=${app}\n`,
        { flag: "a" },
      )
  }
  yield* Console.log(
    `Verified ${app}: ${commit} / ${digest} (CI ${runId}). ${write ? "Updated local pins only." : "Verification only; no files changed."}`,
  )
})

promote().pipe(
  Effect.scoped,
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
