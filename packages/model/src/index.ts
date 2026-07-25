export type { ResolvedVmSpec, VmDefaults, VmInventory, VmSpec } from "./proxmox/index.ts"
export {
  decodeVmDefaults,
  decodeVmInventory,
  resolveVmSpec,
  serverTags,
  tags,
  VmDefaultsSchema,
  VmInventorySchema,
  VmSpecSchema,
  vmResourceName,
} from "./proxmox/index.ts"
export type { NamespaceInventory, NamespaceSpec } from "./kubernetes/index.ts"
export {
  decodeHelmReleaseInventory,
  decodeMetalLbAddressPoolInventory,
  decodeMetalLbL2AdvertisementInventory,
  decodeNamespaceInventory,
  HelmReleaseInventorySchema,
  HelmReleaseSpecSchema,
  MetalLbAddressPoolInventorySchema,
  MetalLbAddressPoolSpecSchema,
  MetalLbL2AdvertisementInventorySchema,
  MetalLbL2AdvertisementSpecSchema,
  NamespaceInventorySchema,
  NamespaceSpecSchema,
} from "./kubernetes/index.ts"
export type {
  HelmReleaseInventory,
  HelmReleaseSpec,
  MetalLbAddressPoolInventory,
  MetalLbAddressPoolSpec,
  MetalLbL2AdvertisementInventory,
  MetalLbL2AdvertisementSpec,
} from "./kubernetes/index.ts"
