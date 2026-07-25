import { strict as assert } from "node:assert"
import { test } from "node:test"

import * as pulumi from "@pulumi/pulumi"
import type { MockResourceArgs } from "@pulumi/pulumi/runtime"
import { Effect } from "effect"

import type { VmInventory, VmSpec } from "@dsqr/model"
import {
  createProxmoxPlatformEffect,
  planProxmoxPlatform,
  type ProxmoxPlatformArgs,
} from "@dsqr/pulumi-proxmox"

const resources: MockResourceArgs[] = []

await pulumi.runtime.setMocks(
  {
    call: (args) => args.inputs,
    newResource: (args) => {
      resources.push(args)
      return { id: `${args.name}-id`, state: args.inputs }
    },
  },
  "pulumi",
  "dev",
  true,
)

const baseVm = {
  name: "first",
  resourceName: "first-resource",
  vmId: 1000,
  nodeName: "pve",
  templateVmId: 9000,
  datastoreId: "local-lvm",
  bridge: "vmbr0",
  cloudInitDiskDatastoreId: "local-lvm",
  cloudInitUserDataFileId: "local:snippets/user-data.yaml",
  macAddress: "02:00:00:00:10:00",
} satisfies VmSpec

const platformArgs = (inventory: VmInventory): ProxmoxPlatformArgs => ({
  connection: {
    endpoint: "https://proxmox.example.test:8006",
    apiToken: "mock-api-token",
    insecure: false,
  },
  defaults: {
    cpuCores: 2,
    memoryMiB: 4096,
    rootDiskSizeGiB: 32,
    tags: [],
  },
  inventory,
})

const duplicateInventory = (overrides: Partial<VmSpec>): VmInventory => ({
  first: baseVm,
  second: {
    ...baseVm,
    name: "second",
    resourceName: "second-resource",
    vmId: 1001,
    macAddress: "02:00:00:00:10:01",
    ...overrides,
  },
})

test("Proxmox planning resolves every VM before registration", () => {
  const plan = Effect.runSync(
    planProxmoxPlatform(
      platformArgs({
        first: baseVm,
      }),
    ),
  )

  assert.equal(plan.providerName, "proxmoxve")
  assert.deepEqual(plan.vms, [
    {
      key: "first",
      spec: {
        ...baseVm,
        cpuCores: 2,
        memoryMiB: 4096,
        rootDiskSizeGiB: 32,
        tags: [],
      },
    },
  ])
})

for (const [label, inventory, expected] of [
  [
    "logical resource name",
    duplicateInventory({ resourceName: baseVm.resourceName }),
    /logical resource names.*first-resource/i,
  ],
  ["VM ID", duplicateInventory({ vmId: baseVm.vmId }), /VM IDs.*1000/i],
  ["physical VM name", duplicateInventory({ name: baseVm.name }), /VM names.*first/i],
  [
    "explicit MAC address",
    duplicateInventory({ macAddress: baseVm.macAddress.toUpperCase() }),
    /MAC addresses.*02:00:00:00:10:00/i,
  ],
] as const) {
  test(`Proxmox rejects a duplicate ${label} before registering any resource`, () => {
    const resourceCount = resources.length
    const error = Effect.runSync(Effect.flip(createProxmoxPlatformEffect(platformArgs(inventory))))

    assert.match(error.message, expected)
    assert.equal(resources.length, resourceCount)
  })
}
