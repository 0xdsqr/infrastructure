import assert from "node:assert/strict"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { NodeContext } from "@effect/platform-node"
import { Effect } from "effect"

import {
  isSupportedSourceTransport,
  parseGitOpsCheckArguments,
  requireLocalGitOpsSourceDirectory,
  resolveLocalGitOpsSourcePath,
} from "../packages/gitops/src/check.ts"
import { parseGitOpsGenerateArguments } from "../packages/gitops/src/generate.ts"
import { formatGitOpsError } from "../packages/gitops/src/main.ts"
import { parseGitOpsRenderArguments } from "../packages/gitops/src/render.ts"
import { listFilesRecursive, runCommand } from "../packages/gitops/src/runtime.ts"

test("Helm OCI transport exceptions require an official Envoy chart and pinned version", () => {
  assert.equal(isSupportedSourceTransport({ repoURL: "https://helm.cilium.io/" }), true)
  for (const chart of ["gateway-helm", "gateway-crds-helm"]) {
    assert.equal(isSupportedSourceTransport({ repoURL: "docker.io/envoyproxy", chart, targetRevision: "v1.9.1" }), true)
  }
  for (const source of [
    { repoURL: "http://helm.cilium.io/" },
    { repoURL: "docker.io/other", chart: "gateway-helm", targetRevision: "v1.9.1" },
    { repoURL: "docker.io/envoyproxy", chart: "other", targetRevision: "v1.9.1" },
    { repoURL: "docker.io/envoyproxy", chart: "gateway-helm", targetRevision: "latest" },
  ]) assert.equal(isSupportedSourceTransport(source), false)
})

test("GitOps CLIs preserve their repository-root contracts", async () => {
  assert.deepEqual(await Effect.runPromise(parseGitOpsCheckArguments([], "/work")), {
    repoRoot: "/work",
  })
  assert.deepEqual(await Effect.runPromise(parseGitOpsCheckArguments(["/repo"], "/work")), {
    repoRoot: "/repo",
  })
  assert.deepEqual(
    await Effect.runPromise(parseGitOpsRenderArguments(["--repo-root", "/repo"], "/work")),
    { repoRoot: "/repo" },
  )
  assert.deepEqual(
    await Effect.runPromise(
      parseGitOpsGenerateArguments(["--check", "--repo-root", "/repo"], "/work"),
    ),
    { check: true, repoRoot: "/repo" },
  )
  assert.equal(await Effect.runPromise(parseGitOpsRenderArguments(["--help"], "/work")), "help")
})

test("GitOps CLIs return typed usage failures", async () => {
  const checkError = await Effect.runPromise(
    parseGitOpsCheckArguments(["one", "two"], "/work").pipe(Effect.flip),
  )
  assert.equal(checkError._tag, "GitOpsUsageError")

  const renderError = await Effect.runPromise(
    parseGitOpsRenderArguments(["--repo-root"], "/work").pipe(Effect.flip),
  )
  assert.equal(renderError._tag, "GitOpsUsageError")
  assert.equal(renderError.message, "--repo-root requires a path")

  const generateError = await Effect.runPromise(
    parseGitOpsGenerateArguments(["--unknown"], "/work").pipe(Effect.flip),
  )
  assert.equal(generateError._tag, "GitOpsUsageError")
  assert.match(generateError.message, /Unknown argument: --unknown/)
})

test("external tool failures remain typed and retain stderr", async () => {
  const error = await Effect.runPromise(
    runCommand({
      command: process.execPath,
      args: ["-e", "process.stderr.write('expected failure'); process.exit(7)"],
    }).pipe(Effect.provide(NodeContext.layer), Effect.flip),
  )

  assert.equal(error._tag, "GitOpsCommandError")
  assert.equal(error.exitCode, 7)
  assert.equal(error.stderr, "expected failure")
  assert.match(formatGitOpsError(error), /expected failure/)
})

test("local GitOps sources are strings contained by the GitOps tree", async () => {
  assert.equal(
    await Effect.runPromise(
      resolveLocalGitOpsSourcePath("/repo", "gitops/components/demo", "demo").pipe(
        Effect.provide(NodeContext.layer),
      ),
    ),
    "/repo/gitops/components/demo",
  )

  for (const sourcePath of [42, "gitops/../../outside"]) {
    const error = await Effect.runPromise(
      resolveLocalGitOpsSourcePath("/repo", sourcePath, "demo").pipe(
        Effect.provide(NodeContext.layer),
        Effect.flip,
      ),
    )
    assert.equal(error._tag, "GitOpsValidationError")
  }
})

test("recursive GitOps traversal does not follow symbolic links", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitops-traversal-"))
  const tree = join(root, "tree")
  const outside = join(root, "outside")
  await Promise.all([mkdir(tree), mkdir(outside)])
  await writeFile(join(tree, "inside.yaml"), "inside")
  await writeFile(join(outside, "outside.yaml"), "outside")
  await symlink(outside, join(tree, "linked"))

  assert.deepEqual(
    await Effect.runPromise(listFilesRecursive(tree).pipe(Effect.provide(NodeContext.layer))),
    [join(tree, "inside.yaml")],
  )
})

test("local GitOps sources cannot escape through symbolic links", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitops-source-"))
  const gitOpsRoot = join(root, "gitops")
  const outside = join(root, "outside")
  await Promise.all([mkdir(gitOpsRoot), mkdir(outside)])
  await symlink(outside, join(gitOpsRoot, "linked"))

  const error = await Effect.runPromise(
    requireLocalGitOpsSourceDirectory(root, "gitops/linked", "demo").pipe(
      Effect.provide(NodeContext.layer),
      Effect.flip,
    ),
  )
  assert.equal(error._tag, "GitOpsValidationError")
  assert.match(error.message, /outside gitops/)
})
