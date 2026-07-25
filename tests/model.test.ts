import { strict as assert } from "node:assert"
import { test } from "node:test"

import { Effect } from "effect"

import { decodeVmDefaults, decodeVmInventory } from "@dsqr/model"

test("Proxmox inventory decoding is effectful and accepts valid resources", () => {
  const defaults = Effect.runSync(
    decodeVmDefaults({
      cpuCores: 2,
      memoryMiB: 4096,
      rootDiskSizeGiB: 32,
      tags: [],
    }),
  )

  assert.equal(defaults.memoryMiB, 4096)
})

test("Proxmox inventory rejects unsafe numeric values", () => {
  const invalidVlan = Effect.runSync(
    Effect.flip(
      decodeVmInventory({
        invalid: {
          name: "invalid",
          vmId: 1,
          nodeName: "pve",
          templateVmId: 9000,
          datastoreId: "local-lvm",
          bridge: "vmbr0",
          vlanTag: 4095,
          cloudInitDiskDatastoreId: "local-lvm",
          cloudInitUserDataFileId: "local:snippets/user-data.yaml",
        },
      }),
    ),
  )

  assert.match(invalidVlan.message, /4095/)

  const invalidCapacity = Effect.runSync(
    Effect.flip(
      decodeVmDefaults({
        cpuCores: 0,
        memoryMiB: 4096,
        rootDiskSizeGiB: 32,
        tags: [],
      }),
    ),
  )

  assert.match(invalidCapacity.message, /Expected a positive number/)
})
