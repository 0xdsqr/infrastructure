import { strict as assert } from "node:assert"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { test } from "node:test"

const root = new URL("../", import.meta.url)
const productionRoots = ["infra", "packages", "tools"] as const

const typescriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? typescriptFiles(path)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [path]
        : []
  })

const productionFiles = productionRoots.flatMap((directory) =>
  typescriptFiles(new URL(`../${directory}/`, import.meta.url).pathname),
)

test("infrastructure production code keeps side effects behind Effect boundaries", () => {
  const violations: string[] = []
  const forbidden = [
    ["ambient process environment", /\bprocess\.env\b/],
    ["raw child process", /node:child_process/],
    ["raw Node filesystem", /from\s+["']node:fs(?:\/promises)?["']/],
    ["raw async function", /\basync\s+(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/],
    ["raw await", /\bawait\b/],
    [
      "raw Promise control flow",
      /\b(?:new\s+Promise|Promise\.(?:all|allSettled|any|race|reject|resolve)|\.then\s*\()/,
    ],
    ["synchronous schema decoder", /\bdecode[A-Za-z0-9_$]*Sync\b/],
  ] as const

  for (const file of productionFiles) {
    const source = readFileSync(file, "utf8")
    const relativePath = relative(root.pathname, file)
    for (const [label, pattern] of forbidden) {
      // Pulumi imports must finish synchronously. This one adapter wraps
      // statSync in Effect.try so asset failures remain typed while the stack
      // stays compatible with runPulumiProgram.
      if (label === "raw Node filesystem" && relativePath === "infra/kubernetes/preflight.ts") {
        continue
      }
      if (pattern.test(source)) {
        violations.push(`${relativePath}: ${label}`)
      }
    }
  }

  assert.deepEqual(violations, [])
})

test("Effect runtime execution is restricted to documented application boundaries", () => {
  const allowed = new Set([
    "packages/gitops/src/bin/check.ts",
    "packages/gitops/src/bin/generate.ts",
    "packages/gitops/src/bin/render.ts",
    "packages/cli/src/bin.ts",
    "packages/pulumi/shared/src/index.ts",
    "tools/migrations/proxmox-v7-to-v8-state.ts",
  ])
  const violations = productionFiles
    .filter((file) =>
      /\b(?:Effect\.run(?:Sync|Promise)|NodeRuntime\.runMain)\b/.test(readFileSync(file, "utf8")),
    )
    .map((file) => relative(root.pathname, file))
    .filter((file) => !allowed.has(file))

  assert.deepEqual(violations, [])
})

test("production shell remains limited to documented process-boundary adapters", () => {
  const ignoredDirectories = new Set([".git", "node_modules"])
  const shellFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (ignoredDirectories.has(entry.name)) return []
      const path = join(directory, entry.name)
      return entry.isDirectory()
        ? shellFiles(path)
        : entry.isFile() && entry.name.endsWith(".sh")
          ? [relative(root.pathname, path)]
          : []
    })

  assert.deepEqual(shellFiles(root.pathname).sort(), [
    "nix/scripts/infra.sh",
    "nix/scripts/proxmox/export-backup.sh",
    "nix/scripts/proxmox/install-monitoring.sh",
    "nix/scripts/proxmox/install-vault-certificate.sh",
    "nix/scripts/proxmox/install.sh",
    "nix/scripts/proxmox/prometheus-lvm-thin-collector.sh",
  ])
})

test("reusable Pulumi packages pin their Effect runtime", () => {
  const packageRoot = new URL("../packages/pulumi/", import.meta.url).pathname
  const manifests = readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packageRoot, entry.name, "package.json"))

  for (const manifest of manifests) {
    const packageJson = JSON.parse(readFileSync(manifest, "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>
    }
    assert.equal(packageJson.dependencies?.effect, "3.22.0", relative(root.pathname, manifest))
  }
})
