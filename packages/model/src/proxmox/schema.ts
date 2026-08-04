import { Schema } from "effect"

const PositiveInteger = Schema.Int.pipe(Schema.positive())
const VlanTag = Schema.Int.pipe(Schema.between(1, 4094))

const VmDataDiskSchema = Schema.Struct({
  interface: Schema.NonEmptyString,
  datastoreId: Schema.NonEmptyString,
  sizeGiB: PositiveInteger,
  backup: Schema.optional(Schema.Boolean),
  discard: Schema.optional(Schema.Boolean),
  replicate: Schema.optional(Schema.Boolean),
  serial: Schema.optional(Schema.NonEmptyString),
})

export const VmSpecSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  resourceName: Schema.optional(Schema.NonEmptyString),
  vmId: PositiveInteger,
  nodeName: Schema.NonEmptyString,
  templateVmId: PositiveInteger,
  datastoreId: Schema.NonEmptyString,
  bridge: Schema.NonEmptyString,
  macAddress: Schema.optional(Schema.NonEmptyString),
  vlanTag: Schema.optional(VlanTag),
  cloudInitDiskDatastoreId: Schema.NonEmptyString,
  cloudInitUserDataFileId: Schema.NonEmptyString,
  cpuCores: Schema.optional(PositiveInteger),
  memoryMiB: Schema.optional(PositiveInteger),
  rootDiskSizeGiB: Schema.optional(PositiveInteger),
  discard: Schema.optional(Schema.Boolean),
  dataDisks: Schema.optional(Schema.Array(VmDataDiskSchema)),
  tags: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})

export const VmDefaultsSchema = Schema.Struct({
  cpuCores: PositiveInteger,
  memoryMiB: PositiveInteger,
  rootDiskSizeGiB: PositiveInteger,
  tags: Schema.Array(Schema.NonEmptyString),
})

export const VmInventorySchema = Schema.Record({
  key: Schema.NonEmptyString,
  value: VmSpecSchema,
})

export const decodeVmDefaults = Schema.decodeUnknown(VmDefaultsSchema, {
  onExcessProperty: "error",
})

export const decodeVmInventory = Schema.decodeUnknown(VmInventorySchema, {
  onExcessProperty: "error",
})
