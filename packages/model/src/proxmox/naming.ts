import type { VmSpec } from "./types.ts"

export function vmResourceName(spec: VmSpec) {
  return spec.resourceName ?? spec.name
}
