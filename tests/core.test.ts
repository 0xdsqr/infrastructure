import assert from "node:assert/strict"
import test from "node:test"

import { infrastructure } from "../infra.config.ts"

test("tracks every Pulumi project from the root configuration", () => {
  assert.deepEqual(Object.keys(infrastructure.stacks), [
    "cloudflare",
    "hetzner",
    "kubernetes",
    "proxmox",
    "tailscale",
    "vault",
  ])
})

test("keeps the all group exhaustive", () => {
  assert.deepEqual([...infrastructure.groups.all].sort(), Object.keys(infrastructure.stacks).sort())
})

test("preserves live Pulumi project identities", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(infrastructure.stacks).map(([name, stack]) => [name, stack.projectName]),
    ),
    {
      cloudflare: "cloudflare-edge",
      hetzner: "hetzner-mail",
      kubernetes: "kubernetes",
      proxmox: "pulumi",
      tailscale: "tailscale-control",
      vault: "vault-homelab",
    },
  )
})
