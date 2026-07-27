export const tailscaleAdminUser = "0xdsqr@github"

const tags = {
  location: {
    homelab: "tag:homelab",
    proxmox: "tag:proxmox",
    cloud: "tag:cloud",
    hetzner: "tag:hetzner",
    aws: "tag:aws",
  },
  role: {
    server: "tag:server",
    workstation: "tag:workstation",
    infra: "tag:infra",
    mail: "tag:mail",
    backup: "tag:backup",
    exitNode: "tag:exit-node",
  },
} as const

type PolicyArgs = {
  adminUser: string
}

function tagOwners(adminUser: string) {
  return {
    [tags.location.homelab]: [adminUser],
    [tags.location.proxmox]: [adminUser],
    [tags.location.cloud]: [adminUser],
    [tags.location.hetzner]: [adminUser],
    [tags.location.aws]: [adminUser],
    [tags.role.server]: [adminUser],
    [tags.role.workstation]: [adminUser],
    [tags.role.infra]: [adminUser],
    [tags.role.mail]: [adminUser],
    [tags.role.backup]: [adminUser],
    [tags.role.exitNode]: [adminUser],
  } as const
}

function createPolicy(args: PolicyArgs) {
  const grants = [
    {
      src: [args.adminUser],
      dst: ["*"],
      ip: ["*"],
    },
    {
      src: [tags.role.workstation],
      dst: ["*"],
      ip: ["*"],
    },
    {
      src: [tags.role.server],
      dst: [tags.role.server],
      ip: ["*"],
    },
  ] as const

  return {
    tagOwners: tagOwners(args.adminUser),
    grants,
    autoApprovers: {
      exitNode: [tags.role.exitNode],
    },
  } as const
}

export const tailscale = {
  tags,
  policyResourceName: "tailnet-policy",
  keySpecs: {},
  createPolicy,
} as const
