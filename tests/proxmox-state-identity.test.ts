import { strict as assert } from "node:assert"
import { test } from "node:test"

import { createProxmoxPlatformEffect } from "@dsqr/pulumi-proxmox"
import { runPulumiProgram } from "@dsqr/pulumi-shared"

import { proxmox } from "../infra/proxmox/config.ts"
import { PROXMOX_V8_VM_TOKEN } from "../tools/migrations/proxmox-v7-to-v8-state.ts"
import { byName, runPulumiMockProgram } from "./pulumi-state-helpers.ts"

const vmToken = PROXMOX_V8_VM_TOKEN

test("Proxmox preserves provider and VM identities, options, and critical inputs", async () => {
  const connection = {
    endpoint: "https://proxmox.example.test:8006",
    apiToken: "mock-api-token",
    insecure: false,
  } as const

  const deployment = await runPulumiMockProgram({
    program: () =>
      runPulumiProgram(
        createProxmoxPlatformEffect({
          connection,
          defaults: proxmox.defaults,
          inventory: proxmox.vms,
        }),
      ),
    outputs: (result) => ({
      provider: result.provider,
      vms: result.vms,
    }),
    newResource: (resource) =>
      resource.type === vmToken
        ? {
            ipv4Addresses: [["10.10.30.200"]],
          }
        : {},
    project: "pulumi",
  })

  assert.deepEqual(
    deployment.resources
      .filter(
        (resource) =>
          resource.type === "pulumi:providers:proxmoxve" || resource.type.startsWith("proxmoxve:"),
      )
      .map((resource) => [resource.type, resource.name] as const)
      .sort((left, right) => left[1].localeCompare(right[1])),
    [
      [vmToken, "backup"],
      [vmToken, "gateway"],
      [vmToken, "k8s-main-cp-01"],
      [vmToken, "k8s-main-w-01"],
      [vmToken, "k8s-main-w-02"],
      [vmToken, "khaos"],
      [vmToken, "knox"],
      [vmToken, "observability"],
      ["pulumi:providers:proxmoxve", "proxmoxve"],
      [vmToken, "vault"],
    ],
  )

  const provider = byName(deployment.captured, "proxmoxve")
  const providerState = byName(deployment.resources, "proxmoxve")
  assert.equal(provider.type, "pulumi:providers:proxmoxve")
  assert.equal(provider.opts.parent, undefined)
  assert.equal(provider.opts.provider, undefined)
  assert.equal(providerState.inputs.endpoint, connection.endpoint)
  assert.equal(providerState.inputs.insecure, "false")

  const vmContracts = [
    ["gateway", "gateway", 1000, 2, 4096, 32, "ssd-dsqr-raid-001", 60, undefined],
    ["observability", "beacon", 1050, 4, 8192, 128, "ssd-dsqr-raid-001", 30, undefined],
    ["khaos", "khaos", 1100, 8, 8192, 200, "ssd-dsqr-raid-001", 30, undefined],
    ["knox", "knox", 1120, 4, 16384, 200, "ssd-dsqr-raid-001", 30, "02:00:00:00:11:20"],
    ["vault", "vault", 1140, 2, 4096, 64, "ssd-dsqr-raid-002", 30, "02:00:00:00:11:40"],
    ["backup", "backup", 1160, 2, 4096, 128, "ssd-dsqr-raid-001", 30, "02:00:00:00:11:60"],
    ["k8s-main-cp-01", "k8s-main-cp-01", 1200, 4, 16384, 100, "ssd-dsqr-raid-001", 30, undefined],
    ["k8s-main-w-01", "k8s-main-w-01", 1210, 4, 8192, 100, "ssd-dsqr-raid-001", 30, undefined],
    ["k8s-main-w-02", "k8s-main-w-02", 1220, 4, 8192, 100, "ssd-dsqr-raid-001", 30, undefined],
  ] as const

  for (const [
    resourceName,
    name,
    vmId,
    cores,
    memory,
    diskSize,
    datastoreId,
    vlanId,
    macAddress,
  ] of vmContracts) {
    const vm = byName(deployment.captured, resourceName)
    const vmState = byName(deployment.resources, resourceName)
    assert.equal(vm.type, vmToken)
    assert.equal(vm.opts.parent, undefined)
    assert.equal(vm.opts.provider, provider.resource)
    assert.deepEqual(vm.opts.dependsOn, undefined)
    assert.deepEqual(vm.opts.ignoreChanges, ["clone.datastoreId", "disks[0].speed"])
    assert.equal(vm.opts.protect, undefined)
    assert.equal(vm.opts.retainOnDelete, undefined)

    assert.equal(vmState.inputs.name, name)
    assert.equal(vmState.inputs.nodeName, "pve")
    assert.equal(vmState.inputs.vmId, vmId)
    assert.deepEqual(vmState.inputs.cpu, { cores, sockets: 1 })
    assert.deepEqual(vmState.inputs.memory, { dedicated: memory })
    assert.equal(vmState.inputs.started, true)
    assert.equal(vmState.inputs.onBoot, true)
    assert.deepEqual(vmState.inputs.clone, {
      datastoreId,
      full: true,
      nodeName: "pve",
      vmId: 9000,
    })
    assert.deepEqual(vmState.inputs.disks, [
      {
        datastoreId,
        interface: "scsi0",
        size: diskSize,
        ...(resourceName === "khaos" ? { discard: "on" } : {}),
      },
    ])
    assert.deepEqual(vmState.inputs.networkDevices, [
      {
        bridge: "vmbr0",
        model: "virtio",
        vlanId,
        ...(macAddress ? { macAddress } : {}),
      },
    ])
  }
})
