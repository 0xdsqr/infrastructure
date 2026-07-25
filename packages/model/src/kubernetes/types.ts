import { Schema } from "effect"

import {
  HelmReleaseInventorySchema,
  HelmReleaseSpecSchema,
  MetalLbAddressPoolInventorySchema,
  MetalLbAddressPoolSpecSchema,
  MetalLbL2AdvertisementInventorySchema,
  MetalLbL2AdvertisementSpecSchema,
  NamespaceInventorySchema,
  NamespaceSpecSchema,
} from "./schema.ts"

export type NamespaceSpec = Schema.Schema.Type<typeof NamespaceSpecSchema>

export type NamespaceInventory = Schema.Schema.Type<typeof NamespaceInventorySchema>

export type HelmReleaseSpec = Schema.Schema.Type<typeof HelmReleaseSpecSchema>

export type HelmReleaseInventory = Schema.Schema.Type<typeof HelmReleaseInventorySchema>

export type MetalLbAddressPoolSpec = Schema.Schema.Type<typeof MetalLbAddressPoolSpecSchema>

export type MetalLbAddressPoolInventory = Schema.Schema.Type<
  typeof MetalLbAddressPoolInventorySchema
>

export type MetalLbL2AdvertisementSpec = Schema.Schema.Type<typeof MetalLbL2AdvertisementSpecSchema>

export type MetalLbL2AdvertisementInventory = Schema.Schema.Type<
  typeof MetalLbL2AdvertisementInventorySchema
>
