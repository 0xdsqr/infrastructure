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
  cluster: {
    indigoNode: "tag:dsqr-indigo-node",
  },
} as const

const hosts = {
  beaconObservability: "100.97.79.78",
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
    [tags.cluster.indigoNode]: [adminUser],
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
    {
      src: [tags.role.mail],
      dst: ["beacon-observability"],
      ip: ["tcp:9090", "tcp:3100"],
    },
    {
      src: [tags.role.mail],
      dst: [tags.role.backup],
      ip: ["tcp:22"],
    },
    {
      src: [tags.role.backup],
      dst: [tags.location.proxmox],
      ip: ["tcp:22"],
    },
  ] as const

  return {
    tagOwners: tagOwners(args.adminUser),
    hosts: {
      "beacon-observability": hosts.beaconObservability,
    },
    grants,
    // Indigo must not retain tag:server: grants are additive, so that tag would
    // restore lateral access even when the restricted Indigo tag is present.
    // These are network-policy assertions for OpenSSH, not Tailscale SSH rules.
    tests: [
      {
        src: args.adminUser,
        proto: "tcp",
        accept: [`${tags.cluster.indigoNode}:22`],
      },
      {
        src: tags.role.workstation,
        proto: "tcp",
        accept: [`${tags.cluster.indigoNode}:22`],
      },
      {
        src: tags.role.server,
        proto: "tcp",
        accept: [`${tags.role.server}:22`],
        deny: [
          `${tags.cluster.indigoNode}:22`,
          `${tags.cluster.indigoNode}:443`,
          `${tags.cluster.indigoNode}:6443`,
          `${tags.cluster.indigoNode}:10250`,
        ],
      },
      {
        src: tags.cluster.indigoNode,
        proto: "tcp",
        deny: [
          `${tags.role.server}:22`,
          `${tags.role.server}:443`,
          `${tags.role.backup}:22`,
          `${tags.cluster.indigoNode}:22`,
          `${tags.cluster.indigoNode}:2379`,
          `${tags.cluster.indigoNode}:6443`,
          `${tags.cluster.indigoNode}:10250`,
          "beacon-observability:9090",
          "beacon-observability:3100",
        ],
      },
    ],
    autoApprovers: {
      exitNode: [tags.role.exitNode],
    },
  } as const
}

export const tailscale = {
  tags,
  hosts,
  policyResourceName: "tailnet-policy",
  // Keep verified node IDs explicit: replacing a device requires an inventory
  // review instead of silently selecting another machine with the same name.
  deviceTagSpecs: {
    indigoControl01: {
      resourceName: "dsqr-indigo-control-01-tags",
      deviceId: "nm4BFMYxnZ11CNTRL",
      tags: [tags.cluster.indigoNode],
    },
    indigoControl02: {
      resourceName: "dsqr-indigo-control-02-tags",
      deviceId: "nH9Rfjf4oE11CNTRL",
      tags: [tags.cluster.indigoNode],
    },
    indigoControl03: {
      resourceName: "dsqr-indigo-control-03-tags",
      deviceId: "nXV4JPcFBh11CNTRL",
      tags: [tags.cluster.indigoNode],
    },
    indigoWorker01: {
      resourceName: "dsqr-indigo-worker-01-tags",
      deviceId: "nE487d2SVb11CNTRL",
      tags: [tags.cluster.indigoNode],
    },
    indigoWorker02: {
      resourceName: "dsqr-indigo-worker-02-tags",
      deviceId: "nVhza1oALE11CNTRL",
      tags: [tags.cluster.indigoNode],
    },
    indigoWorker03: {
      resourceName: "dsqr-indigo-worker-03-tags",
      deviceId: "n35gDmGxvw11CNTRL",
      tags: [tags.cluster.indigoNode],
    },
  },
  keySpecs: {
    indigoNode: {
      resourceName: "dsqr-indigo-node-key",
      description: "DSQR Indigo node bootstrap",
      tags: [tags.cluster.indigoNode],
      lifecycle: "server-bootstrap",
    },
    homelabServer: {
      resourceName: "homelab-server-key",
      description: "Reusable bootstrap enrollment for homelab servers",
      tags: [tags.location.homelab, tags.role.server],
      lifecycle: "server-bootstrap",
    },
    homelabBackup: {
      resourceName: "homelab-backup-key",
      description: "Homelab backup server bootstrap",
      tags: [tags.location.homelab, tags.role.backup],
      lifecycle: "server-bootstrap",
    },
    mailServer: {
      resourceName: "cloud-mail-key",
      description: "Cloud mail server bootstrap",
      tags: [tags.location.cloud, tags.location.hetzner, tags.role.mail],
      lifecycle: "server-bootstrap",
    },
  },
  createPolicy,
} as const
