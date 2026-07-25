import { Schema } from "effect"

const StringMapSchema = Schema.Record({
  key: Schema.String,
  value: Schema.String,
})

export const NamespaceSpecSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  labels: Schema.optional(StringMapSchema),
  annotations: Schema.optional(StringMapSchema),
})

export const NamespaceInventorySchema = Schema.Record({
  key: Schema.NonEmptyString,
  value: NamespaceSpecSchema,
})

export const HelmReleaseSpecSchema = Schema.Struct({
  releaseName: Schema.NonEmptyString,
  namespace: Schema.NonEmptyString,
  chart: Schema.NonEmptyString,
  enabled: Schema.optional(Schema.Boolean),
  repository: Schema.optional(Schema.NonEmptyString),
  version: Schema.optional(Schema.NonEmptyString),
  values: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
  ),
  valueYamlFiles: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  dependsOn: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})

export const HelmReleaseInventorySchema = Schema.Record({
  key: Schema.NonEmptyString,
  value: HelmReleaseSpecSchema,
})

export const MetalLbAddressPoolSpecSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  namespace: Schema.NonEmptyString,
  addresses: Schema.Array(Schema.NonEmptyString),
  autoAssign: Schema.optional(Schema.Boolean),
  avoidBuggyIPs: Schema.optional(Schema.Boolean),
})

export const MetalLbAddressPoolInventorySchema = Schema.Record({
  key: Schema.NonEmptyString,
  value: MetalLbAddressPoolSpecSchema,
})

export const MetalLbL2AdvertisementSpecSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  namespace: Schema.NonEmptyString,
  ipAddressPools: Schema.Array(Schema.NonEmptyString),
})

export const MetalLbL2AdvertisementInventorySchema = Schema.Record({
  key: Schema.NonEmptyString,
  value: MetalLbL2AdvertisementSpecSchema,
})

export const decodeNamespaceInventory = Schema.decodeUnknown(NamespaceInventorySchema, {
  onExcessProperty: "error",
})

export const decodeHelmReleaseInventory = Schema.decodeUnknown(HelmReleaseInventorySchema, {
  onExcessProperty: "error",
})

export const decodeMetalLbAddressPoolInventory = Schema.decodeUnknown(
  MetalLbAddressPoolInventorySchema,
  {
    onExcessProperty: "error",
  },
)

export const decodeMetalLbL2AdvertisementInventory = Schema.decodeUnknown(
  MetalLbL2AdvertisementInventorySchema,
  {
    onExcessProperty: "error",
  },
)
