import { defineStacks } from "@dsqr/core"

import { cloudflare } from "./infra/cloudflare/config.ts"
import { hetznerMail } from "./infra/hetzner/config.ts"
import { kubernetes } from "./infra/kubernetes/config.ts"
import { proxmox } from "./infra/proxmox/config.ts"
import { tailscale } from "./infra/tailscale/config.ts"
import { vault } from "./infra/vault/config.ts"

export const infrastructure = {
  name: "infrastructure",
  stage: "dev",
  cloudflare,
  hetzner: {
    mail: hetznerMail,
  },
  kubernetes,
  proxmox,
  tailscale,
  vault,
  ...defineStacks({
    rootDirectory: new URL("./", import.meta.url),
    projects: {
      cloudflare: {
        projectName: "cloudflare-edge",
        description: "Homelab Cloudflare tunnel and DNS stack",
      },
      hetzner: {
        projectName: "hetzner-mail",
        description: "Hetzner Cloud mail server bootstrap stack",
      },
      kubernetes: {
        description: "Homelab Kubernetes platform stack",
      },
      proxmox: {
        projectName: "pulumi",
        description: "Homelab Proxmox VE stack",
      },
      tailscale: {
        projectName: "tailscale-control",
        description: "Homelab Tailscale policy and auth key stack",
      },
      vault: {
        projectName: "vault-homelab",
        description: "Homelab Vault mounts, policies, and authentication stack",
      },
    },
    groups: {
      default: ["proxmox", "tailscale", "hetzner", "cloudflare"],
      k8s: ["kubernetes"],
      security: ["vault"],
      all: ["proxmox", "tailscale", "hetzner", "cloudflare", "kubernetes", "vault"],
    },
  }),
} as const

export default infrastructure
