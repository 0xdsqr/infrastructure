export { vmResourceName } from "./naming.ts"
export { resolveVmSpec } from "./resolve.ts"
export {
  decodeVmDefaults,
  decodeVmInventory,
  VmDefaultsSchema,
  VmInventorySchema,
  VmSpecSchema,
} from "./schema.ts"
export { serverTags, tags } from "./tags.ts"
export type { ResolvedVmSpec, VmDefaults, VmInventory, VmSpec } from "./types.ts"
