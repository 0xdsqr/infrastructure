import * as proxmox from "@muhlba91/pulumi-proxmoxve"
import * as pulumi from "@pulumi/pulumi"

import { resolveVmSpec, type ResolvedVmSpec, type VmDefaults, type VmSpec } from "@dsqr/model"
import { registerPulumiResource, transformResourceArgs, type Transform } from "@dsqr/pulumi-shared"

export type ProxmoxVmTransforms = {
  vm?: Transform<proxmox.VmLegacyArgs, pulumi.CustomResourceOptions>
}

function firstIpv4Address(addresses: unknown): string | null {
  if (!Array.isArray(addresses)) {
    return null
  }

  for (const interfaceAddresses of addresses) {
    if (!Array.isArray(interfaceAddresses)) {
      continue
    }

    const primaryAddress = interfaceAddresses.find(
      (address): address is string => typeof address === "string" && address.length > 0,
    )

    if (primaryAddress && primaryAddress !== "127.0.0.1") {
      return primaryAddress
    }
  }

  return null
}

type ResolvedProxmoxVmArgs = {
  spec: ResolvedVmSpec
  provider: proxmox.Provider
  transform?: ProxmoxVmTransforms
}

export function createResolvedProxmoxVmEffect(args: ResolvedProxmoxVmArgs) {
  const { spec, provider } = args
  return registerPulumiResource(
    spec.resourceName,
    () =>
      new proxmox.VmLegacy(
        ...transformResourceArgs(
          args.transform?.vm,
          spec.resourceName,
          {
            name: spec.name,
            nodeName: spec.nodeName,
            vmId: spec.vmId,
            tags: [...spec.tags],
            agent: {
              enabled: true,
              type: "virtio",
              waitForIp: {
                ipv4: true,
              },
            },
            cpu: {
              cores: spec.cpuCores,
              sockets: 1,
            },
            memory: {
              dedicated: spec.memoryMiB,
            },
            started: true,
            onBoot: true,
            clone: {
              nodeName: spec.nodeName,
              vmId: spec.templateVmId,
              full: true,
              datastoreId: spec.datastoreId,
            },
            initialization: {
              datastoreId: spec.cloudInitDiskDatastoreId,
              interface: "ide2",
              type: "nocloud",
              userDataFileId: spec.cloudInitUserDataFileId,
              ipConfigs: [
                {
                  ipv4: {
                    address: "dhcp",
                  },
                },
              ],
            },
            disks: [
              {
                interface: "scsi0",
                datastoreId: spec.datastoreId,
                size: spec.rootDiskSizeGiB,
                ...(spec.discard ? { discard: "on" } : {}),
              },
              ...(spec.dataDisks ?? []).map((disk) => ({
                interface: disk.interface,
                datastoreId: disk.datastoreId,
                size: disk.sizeGiB,
                ...(disk.backup === undefined ? {} : { backup: disk.backup }),
                ...(disk.discard ? { discard: "on" } : {}),
                ...(disk.replicate === undefined ? {} : { replicate: disk.replicate }),
                ...(disk.serial === undefined ? {} : { serial: disk.serial }),
              })),
            ],
            networkDevices: [
              {
                bridge: spec.bridge,
                model: "virtio",
                ...(spec.macAddress === undefined ? {} : { macAddress: spec.macAddress }),
                ...(spec.vlanTag === undefined ? {} : { vlanId: spec.vlanTag }),
              },
            ],
          },
          {
            ignoreChanges: [
              "clone.datastoreId",
              ...Array.from(
                { length: 1 + (spec.dataDisks?.length ?? 0) },
                (_, index) => `disks[${index}].speed`,
              ),
            ],
            provider,
          },
        ),
      ),
  )
}

export function createProxmoxVmEffect(args: {
  spec: VmSpec
  provider: proxmox.Provider
  defaults: VmDefaults
  transform?: ProxmoxVmTransforms
}) {
  return createResolvedProxmoxVmEffect({
    spec: resolveVmSpec(args.spec, args.defaults),
    provider: args.provider,
    ...(args.transform ? { transform: args.transform } : {}),
  })
}

export function describeVm(vm: proxmox.VmLegacy) {
  return {
    id: vm.id,
    name: vm.name,
    ipv4Addresses: vm.ipv4Addresses,
    primaryIpv4: vm.ipv4Addresses.apply(firstIpv4Address),
    nodeName: vm.nodeName,
    status: pulumi.output(vm.started).apply((started) => (started ? "running" : "stopped")),
  }
}
