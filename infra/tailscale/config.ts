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
      src: [tags.role.infra],
      dst: [tags.role.server],
      ip: ["tcp:22", "tcp:443"],
    },
    {
      src: [tags.role.server],
      dst: [tags.role.backup],
      ip: ["tcp:22"],
    },
    {
      src: [tags.role.mail],
      dst: [tags.role.backup],
      ip: ["tcp:22"],
    },
  ] as const

  return {
    tagOwners: tagOwners(args.adminUser),
    grants,
    tests: [
      {
        src: args.adminUser,
        accept: [`${tags.role.server}:5432`, `${tags.role.infra}:8006`],
      },
      {
        src: tags.role.infra,
        accept: [`${tags.role.server}:22`, `${tags.role.server}:443`],
        deny: [`${tags.role.server}:5432`, `${tags.role.backup}:22`],
      },
      {
        src: tags.role.server,
        accept: [`${tags.role.backup}:22`],
        deny: [`${tags.role.server}:22`, `${tags.role.infra}:8006`],
      },
      {
        src: tags.role.mail,
        accept: [`${tags.role.backup}:22`],
        deny: [`${tags.role.server}:443`, `${tags.role.infra}:8006`],
      },
    ],
  } as const
}

export const tailscale = {
  tags,
  policyResourceName: "tailnet-policy",
  keySpecs: {
    proxmoxControlPlane: {
      resourceName: "proxmox-control-plane-key",
      description: "proxmox control plane auth key",
      tags: [tags.location.homelab, tags.location.proxmox, tags.role.infra],
    },
    homelabServer: {
      resourceName: "homelab-server-key",
      description: "homelab server auth key",
      tags: [tags.location.homelab, tags.role.server],
    },
    homelabBackup: {
      resourceName: "homelab-backup-key",
      description: "homelab backup auth key",
      tags: [tags.location.homelab, tags.role.backup],
    },
    opnsenseExitNode: {
      resourceName: "opnsense-exit-node-key",
      description: "opnsense exit node auth key",
      tags: [tags.location.homelab, tags.role.infra, tags.role.exitNode],
    },
    hetznerMail: {
      resourceName: "hetzner-mail-key",
      description: "hetzner mail auth key",
      tags: [tags.location.cloud, tags.location.hetzner, tags.role.mail],
    },
    awsServer: {
      resourceName: "aws-server-key",
      description: "aws server auth key",
      tags: [tags.location.cloud, tags.location.aws, tags.role.server],
    },
  },
  createPolicy,
} as const
