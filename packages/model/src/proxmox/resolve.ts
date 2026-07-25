import { vmResourceName } from "./naming.ts"
import type { ResolvedVmSpec, VmDefaults, VmSpec } from "./types.ts"

export function resolveVmSpec(spec: VmSpec, defaults: VmDefaults): ResolvedVmSpec {
  return {
    ...spec,
    resourceName: vmResourceName(spec),
    cpuCores: spec.cpuCores ?? defaults.cpuCores,
    memoryMiB: spec.memoryMiB ?? defaults.memoryMiB,
    rootDiskSizeGiB: spec.rootDiskSizeGiB ?? defaults.rootDiskSizeGiB,
    tags: [...(spec.tags ?? defaults.tags)],
  }
}
