import type {
  HelmReleaseInventory,
  NamespaceInventory,
  MetalLbAddressPoolInventory,
  MetalLbL2AdvertisementInventory,
} from "@dsqr/model"

// Hub-A is retired. Indigo is bootstrapped independently through native GitOps.
// Keep this stack empty so a later infra up cannot recreate the legacy control plane.
export const kubernetes = {
  namespaces: {} satisfies NamespaceInventory,
  helmReleases: {} satisfies HelmReleaseInventory,
  metallb: {
    addressPools: {} satisfies MetalLbAddressPoolInventory,
    l2Advertisements: {} satisfies MetalLbL2AdvertisementInventory,
  },
} as const
