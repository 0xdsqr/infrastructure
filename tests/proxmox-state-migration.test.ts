import assert from "node:assert/strict"
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { Effect } from "effect"

import {
  PROXMOX_V7_VM_TOKEN,
  PROXMOX_V8_VM_TOKEN,
  PULUMI_STATE_FILE_SUFFIX,
  countTokenOccurrences,
  migrateProxmoxV7StateFile,
  proxmoxStateMigrationProgram,
  transformProxmoxV7State,
  type JsonValue,
} from "../tools/migrations/proxmox-v7-to-v8-state.ts"

const oldUrn = `urn:pulumi:dev::pulumi::${PROXMOX_V7_VM_TOKEN}::khaos`
const newUrn = `urn:pulumi:dev::pulumi::${PROXMOX_V8_VM_TOKEN}::khaos`

const runWithNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)))

const stateFixture = (): JsonValue => ({
  version: 3,
  deployment: {
    manifest: {
      time: "2026-07-25T00:00:00.000Z",
    },
    resources: [
      {
        urn: "urn:pulumi:dev::pulumi::pulumi:pulumi:Stack::pulumi-dev",
        type: "pulumi:pulumi:Stack",
      },
      {
        urn: oldUrn,
        type: PROXMOX_V7_VM_TOKEN,
        id: "1100",
        parent: "urn:pulumi:dev::pulumi::pulumi:providers:proxmoxve::default",
        dependencies: [oldUrn],
        inputs: {
          name: "khaos",
          vmId: 1100,
          description: "proxmoxve:VM/virtualMachine:VirtualMachines remains unchanged",
          nested: {
            migrationToken: PROXMOX_V7_VM_TOKEN,
          },
        },
        outputs: {
          ipv4Addresses: [["10.10.30.107"]],
        },
      },
      {
        urn: `urn:pulumi:dev::pulumi::${PROXMOX_V8_VM_TOKEN}::already-migrated`,
        type: PROXMOX_V8_VM_TOKEN,
        id: "1120",
      },
    ],
  },
  [PROXMOX_V7_VM_TOKEN]: "object keys are structural and remain unchanged",
})

test("replaces every exact token occurrence while preserving state structure", () => {
  const input = stateFixture()
  const before = structuredClone(input)
  const inputOldTokenCount = countTokenOccurrences(input, PROXMOX_V7_VM_TOKEN)
  const inputNewTokenCount = countTokenOccurrences(input, PROXMOX_V8_VM_TOKEN)
  const result = Effect.runSync(transformProxmoxV7State(input))

  assert.equal(inputOldTokenCount, 4)
  assert.equal(result.replacements, inputOldTokenCount)
  assert.equal(countTokenOccurrences(result.state, PROXMOX_V7_VM_TOKEN), 0)
  assert.equal(result.outputNewTokenCount, inputNewTokenCount + inputOldTokenCount)
  assert.deepEqual(input, before, "the in-memory input must not be mutated")

  const output = result.state as Record<string, JsonValue>
  const deployment = output.deployment as Record<string, JsonValue>
  const resources = deployment.resources as JsonValue[]
  const vm = resources[1] as Record<string, JsonValue>
  const inputs = vm.inputs as Record<string, JsonValue>

  assert.equal(vm.urn, newUrn)
  assert.equal(vm.type, PROXMOX_V8_VM_TOKEN)
  assert.equal(vm.id, "1100")
  assert.deepEqual(vm.dependencies, [newUrn])
  assert.equal(inputs.description, "proxmoxve:VM/virtualMachine:VirtualMachines remains unchanged")
  assert.ok(PROXMOX_V7_VM_TOKEN in output, "object keys must not be renamed")
})

test("rejects input without a v7 VM token", () => {
  const error = Effect.runSync(
    transformProxmoxV7State({
      version: 3,
      deployment: {
        resources: [],
      },
    }).pipe(Effect.flip),
  )

  assert.deepEqual(
    {
      tag: error._tag,
      reason: error.reason,
    },
    {
      tag: "ProxmoxStateMigrationInvariantError",
      reason: "NoSourceTokens",
    },
  )
  assert.match(error.message, /Input contains no/)
})

test("reports invalid CLI usage as a typed error", async () => {
  const error = await runWithNode(proxmoxStateMigrationProgram([]).pipe(Effect.flip))

  assert.equal(error._tag, "ProxmoxStateMigrationUsageError")
  assert.match(error.message, /^Usage:/)
})

test("reports missing input as a typed filesystem error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxmox-state-migration-"))
  const inputPath = join(directory, `missing${PULUMI_STATE_FILE_SUFFIX}`)
  const outputPath = join(directory, `v8${PULUMI_STATE_FILE_SUFFIX}`)
  const error = await runWithNode(
    migrateProxmoxV7StateFile(inputPath, outputPath).pipe(Effect.flip),
  )

  assert.equal(error._tag, "ProxmoxStateMigrationFileSystemError")
  assert.equal(error.operation, "RealPath")
  assert.equal(error.path, inputPath)
})

test("writes deterministic JSON to a separate, private file without changing the input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxmox-state-migration-"))
  const inputPath = join(directory, `v7${PULUMI_STATE_FILE_SUFFIX}`)
  const outputPath = join(directory, `v8${PULUMI_STATE_FILE_SUFFIX}`)
  const inputSource = JSON.stringify(stateFixture())

  await writeFile(inputPath, inputSource)

  const summary = await runWithNode(migrateProxmoxV7StateFile(inputPath, outputPath))
  const outputSource = await readFile(outputPath, "utf8")

  assert.equal(await readFile(inputPath, "utf8"), inputSource)
  assert.equal(summary.replacements, 4)
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600)
  assert.ok(outputSource.endsWith("\n"))
  assert.deepEqual(
    JSON.parse(outputSource),
    Effect.runSync(transformProxmoxV7State(stateFixture())).state,
  )
})

test("refuses identical input and output paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxmox-state-migration-"))
  const inputPath = join(directory, `state${PULUMI_STATE_FILE_SUFFIX}`)

  await writeFile(inputPath, JSON.stringify(stateFixture()))

  const error = await runWithNode(migrateProxmoxV7StateFile(inputPath, inputPath).pipe(Effect.flip))

  assert.equal(error._tag, "ProxmoxStateMigrationPathError")
  assert.equal(error.reason, "SamePath")
  assert.match(error.message, /Input and output paths must be different/)
})

test("refuses an output symlink that resolves to the input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxmox-state-migration-"))
  const inputPath = join(directory, `state${PULUMI_STATE_FILE_SUFFIX}`)
  const outputPath = join(directory, `state-output${PULUMI_STATE_FILE_SUFFIX}`)

  await writeFile(inputPath, JSON.stringify(stateFixture()))
  await symlink(inputPath, outputPath)

  const error = await runWithNode(
    migrateProxmoxV7StateFile(inputPath, outputPath).pipe(Effect.flip),
  )

  assert.equal(error._tag, "ProxmoxStateMigrationPathError")
  assert.equal(error.reason, "SameEntry")
  assert.match(error.message, /resolve to the same filesystem entry/)
})

test("refuses to overwrite an existing output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxmox-state-migration-"))
  const inputPath = join(directory, `v7${PULUMI_STATE_FILE_SUFFIX}`)
  const outputPath = join(directory, `v8${PULUMI_STATE_FILE_SUFFIX}`)

  await writeFile(inputPath, JSON.stringify(stateFixture()))
  await writeFile(outputPath, "preserve me")

  const error = await runWithNode(
    migrateProxmoxV7StateFile(inputPath, outputPath).pipe(Effect.flip),
  )

  assert.equal(error._tag, "ProxmoxStateMigrationPathError")
  assert.equal(error.reason, "OutputExists")
  assert.match(error.message, /Output already exists; choose a new path/)
  assert.equal(await readFile(outputPath, "utf8"), "preserve me")
})

test("rejects malformed JSON without creating an output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxmox-state-migration-"))
  const inputPath = join(directory, `v7${PULUMI_STATE_FILE_SUFFIX}`)
  const outputPath = join(directory, `v8${PULUMI_STATE_FILE_SUFFIX}`)

  await writeFile(inputPath, "{")

  const error = await runWithNode(
    migrateProxmoxV7StateFile(inputPath, outputPath).pipe(Effect.flip),
  )

  assert.equal(error._tag, "ProxmoxStateMigrationJsonError")
  assert.match(error.message, /not valid JSON/)
  await assert.rejects(readFile(outputPath, "utf8"), /ENOENT/)
})

test("requires the ignored Pulumi state filename convention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxmox-state-migration-"))
  const inputPath = join(directory, "state.json")
  const outputPath = join(directory, "state-v8.json")

  await writeFile(inputPath, JSON.stringify(stateFixture()))

  const error = await runWithNode(
    migrateProxmoxV7StateFile(inputPath, outputPath).pipe(Effect.flip),
  )

  assert.equal(error._tag, "ProxmoxStateMigrationPathError")
  assert.equal(error.reason, "UnsafeFilename")
  assert.match(error.message, new RegExp(`${PULUMI_STATE_FILE_SUFFIX.replaceAll(".", "\\.")}$`))
  await assert.rejects(readFile(outputPath, "utf8"), /ENOENT/)
})
