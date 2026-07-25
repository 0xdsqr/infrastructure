import { Schema } from "effect"

import { VmDefaultsSchema, VmInventorySchema, VmSpecSchema } from "./schema.ts"

export type VmSpec = Schema.Schema.Type<typeof VmSpecSchema>

export type VmDefaults = Schema.Schema.Type<typeof VmDefaultsSchema>

export type ResolvedVmSpec = Omit<
  VmSpec,
  "resourceName" | "cpuCores" | "memoryMiB" | "rootDiskSizeGiB" | "tags"
> & {
  readonly resourceName: string
  readonly cpuCores: number
  readonly memoryMiB: number
  readonly rootDiskSizeGiB: number
  readonly tags: ReadonlyArray<string>
}

export type VmInventory = Schema.Schema.Type<typeof VmInventorySchema>
