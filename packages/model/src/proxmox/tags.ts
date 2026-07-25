const baseServerTags = ["nixos", "server", "pulumi"] as const

export const serverTags: string[] = [...baseServerTags]

export function tags(...specificTags: ReadonlyArray<string>): string[] {
  return [...specificTags, ...baseServerTags]
}
