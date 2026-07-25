import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { NodeContext } from "@effect/platform-node"
import { ConfigProvider, Effect } from "effect"

import { defineStacks, resolveStackRegistry } from "@dsqr/core"

test("INFRA_ROOT resolves projects outside a bundled CLI location", async () => {
  const root = mkdtempSync(join(tmpdir(), "infra-root-"))
  const project = join(root, "infra", "example")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "index.ts"), "")
  writeFileSync(join(project, "Pulumi.yaml"), "name: example-project\nruntime: nodejs\n")

  const registry = defineStacks({
    rootDirectory: new URL("file:///nix/store/example/libexec/"),
    projects: {
      example: {
        description: "Example",
        projectName: "example-project",
      },
    },
    groups: {
      default: ["example"],
    },
  })
  const provider = ConfigProvider.fromMap(new Map([["INFRA_ROOT", root]]))
  const resolved = await Effect.runPromise(
    resolveStackRegistry(registry).pipe(
      Effect.withConfigProvider(provider),
      Effect.provide(NodeContext.layer),
    ),
  )

  assert.equal(resolved.stacks.example?.directory, project)
  assert.equal(resolved.stacks.example?.program, join(project, "index.ts"))
})
