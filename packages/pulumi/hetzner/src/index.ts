import { isIP } from "node:net"

import * as hcloud from "@pulumi/hcloud"
import type * as pulumi from "@pulumi/pulumi"
import { Effect } from "effect"
import {
  PulumiResourceConfigError,
  registerPulumiResource,
  requireResourceConfigEffect,
} from "@dsqr/pulumi-shared"

export interface HetznerMailServerConfig {
  readonly name?: string | undefined
  readonly serverType?: string | undefined
  readonly location?: string | undefined
  readonly image?: string | undefined
  readonly architecture?: "x86" | "arm" | undefined
  readonly sshKeyName: string
  readonly createFirewall?: boolean | undefined
  readonly adminIpv4?: string | undefined
  readonly adminIpv6?: string | undefined
  readonly rdnsHostname: string
  readonly resourceNames?:
    | {
        readonly firewall?: string | undefined
        readonly server?: string | undefined
        readonly ipv4Rdns?: string | undefined
      }
    | undefined
  readonly resourceOptions?: pulumi.CustomResourceOptions | undefined
}

export interface HetznerMailServer {
  readonly server: hcloud.Server
  readonly firewall: hcloud.Firewall | undefined
  readonly ipv4RdnsRecord: hcloud.Rdns
  readonly serverType: string
  readonly location: string
  readonly image: string
  readonly sshKeyName: pulumi.Output<string>
}

const defaults = {
  name: "mail-vps",
  serverType: "cpx11",
  location: "ash",
  image: "ubuntu-24.04",
  architecture: "x86" as const,
  createFirewall: true,
  resourceNames: {
    firewall: "mail-firewall",
    server: "mail-vps",
    ipv4Rdns: "mail-ipv4-rdns",
  },
}

export const hetznerMailServiceTcpPorts = ["25", "80", "443", "465", "587", "993", "4190"] as const

export function asSingleHostCidr(ip: string, family: "ipv4" | "ipv6") {
  return ip.includes("/") ? ip : `${ip}/${family === "ipv4" ? "32" : "128"}`
}

export function isValidHostOrCidr(value: string, family: "ipv4" | "ipv6") {
  if (value !== value.trim()) {
    return false
  }

  const segments = value.split("/")
  if (segments.length > 2) {
    return false
  }

  const [address, prefix] = segments
  const expectedFamily = family === "ipv4" ? 4 : 6
  if (!address || address.includes("%") || isIP(address) !== expectedFamily) {
    return false
  }

  if (prefix === undefined) {
    return true
  }

  const maximumPrefix = family === "ipv4" ? 32 : 128
  return /^(0|[1-9][0-9]*)$/.test(prefix) && Number(prefix) <= maximumPrefix
}

export function isValidRdnsHostname(value: string) {
  if (value !== value.trim() || value.length === 0 || value.length > 253) {
    return false
  }

  const hostname = value.endsWith(".") ? value.slice(0, -1) : value
  const labels = hostname.split(".")

  return (
    hostname.length > 0 &&
    isIP(hostname) === 0 &&
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  )
}

function missingProviderResult(resource: string, message: string) {
  return new PulumiResourceConfigError({ resource, message })
}

export const validateHetznerMailServerConfig = Effect.fn("Hetzner.validateMailServerConfig")(
  function* (config: HetznerMailServerConfig) {
    const name = config.name ?? defaults.name
    const serverType = config.serverType ?? defaults.serverType
    const location = config.location ?? defaults.location
    const imageName = config.image ?? defaults.image
    const createFirewall = config.createFirewall ?? defaults.createFirewall
    const resourceNames = {
      firewall: config.resourceNames?.firewall ?? defaults.resourceNames.firewall,
      server: config.resourceNames?.server ?? defaults.resourceNames.server,
      ipv4Rdns: config.resourceNames?.ipv4Rdns ?? defaults.resourceNames.ipv4Rdns,
    }

    const requiredStrings = {
      name,
      serverType,
      location,
      image: imageName,
      sshKeyName: config.sshKeyName,
    } as const

    for (const [field, value] of Object.entries(requiredStrings)) {
      yield* requireResourceConfigEffect(
        value.trim().length > 0,
        `hetzner-mail:${field}`,
        `\`hetzner-mail:${field}\` must not be empty.`,
      )
    }

    yield* requireResourceConfigEffect(
      config.adminIpv4 === undefined || isValidHostOrCidr(config.adminIpv4, "ipv4"),
      "hetzner-mail:adminIpv4",
      "`hetzner-mail:adminIpv4` must be a valid IPv4 host or CIDR.",
    )
    yield* requireResourceConfigEffect(
      config.adminIpv6 === undefined || isValidHostOrCidr(config.adminIpv6, "ipv6"),
      "hetzner-mail:adminIpv6",
      "`hetzner-mail:adminIpv6` must be a valid IPv6 host or CIDR.",
    )
    yield* requireResourceConfigEffect(
      !createFirewall || Boolean(config.adminIpv4 || config.adminIpv6),
      "hetzner-mail:firewall",
      "`hetzner-mail:adminIpv4` or `hetzner-mail:adminIpv6` is required when the managed firewall is enabled.",
    )
    yield* requireResourceConfigEffect(
      isValidRdnsHostname(config.rdnsHostname),
      "hetzner-mail:rdnsHostname",
      "`hetzner-mail:rdnsHostname` must be a valid DNS hostname.",
    )
    yield* requireResourceConfigEffect(
      new Set(Object.values(resourceNames)).size === Object.values(resourceNames).length &&
        Object.values(resourceNames).every((value) => value.trim().length > 0),
      "hetzner-mail:resourceNames",
      "Pulumi logical resource names must be non-empty and unique.",
    )

    return {
      name,
      serverType,
      location,
      imageName,
      createFirewall,
      resourceNames,
    } as const
  },
)

export const createHetznerMailServerEffect = Effect.fn("Hetzner.createMailServer")(function* (
  config: HetznerMailServerConfig,
) {
  const architecture = config.architecture ?? defaults.architecture
  const { name, serverType, location, imageName, createFirewall, resourceNames } =
    yield* validateHetznerMailServerConfig(config)

  const sshKey = yield* registerPulumiResource(`lookup:ssh-key:${config.sshKeyName}`, () =>
    hcloud.getSshKeyOutput({
      name: config.sshKeyName,
    }),
  )

  const resolvedSshKeyName = sshKey.apply((result) => {
    if (!result.name) {
      throw missingProviderResult(
        "hetzner:ssh-key",
        `No Hetzner SSH key found for name "${config.sshKeyName}".`,
      )
    }

    return result.name
  })

  const image = yield* registerPulumiResource(`lookup:image:${imageName}`, () =>
    hcloud.getImageOutput({
      name: imageName,
      withArchitecture: architecture,
    }),
  )

  const resolvedImageName = image.apply((result) => {
    if (!result.name) {
      throw missingProviderResult(
        "hetzner:image",
        `No Hetzner image found for "${imageName}" with architecture "${architecture}".`,
      )
    }

    return result.name
  })

  const firewallRules = [
    config.adminIpv4
      ? {
          direction: "in" as const,
          protocol: "tcp" as const,
          port: "22",
          sourceIps: [asSingleHostCidr(config.adminIpv4, "ipv4")],
          description: "SSH from home IPv4",
        }
      : undefined,
    config.adminIpv6
      ? {
          direction: "in" as const,
          protocol: "tcp" as const,
          port: "22",
          sourceIps: [asSingleHostCidr(config.adminIpv6, "ipv6")],
          description: "SSH from home IPv6",
        }
      : undefined,
    ...hetznerMailServiceTcpPorts.map((port) => ({
      direction: "in" as const,
      protocol: "tcp" as const,
      port,
      sourceIps: ["0.0.0.0/0", "::/0"],
      description: `mail service tcp/${port}`,
    })),
  ].filter((rule): rule is NonNullable<typeof rule> => rule !== undefined)

  const firewall = createFirewall
    ? yield* registerPulumiResource(
        resourceNames.firewall,
        () =>
          new hcloud.Firewall(
            resourceNames.firewall,
            {
              name: `${name}-ssh`,
              labels: {
                role: "mail",
                provider: "hetzner",
                stack: "mail",
              },
              rules: firewallRules,
            },
            config.resourceOptions,
          ),
      )
    : undefined

  const server = yield* registerPulumiResource(
    resourceNames.server,
    () =>
      new hcloud.Server(
        resourceNames.server,
        {
          name,
          serverType,
          location,
          image: resolvedImageName,
          backups: false,
          deleteProtection: false,
          rebuildProtection: false,
          keepDisk: true,
          publicNets: [
            {
              ipv4Enabled: true,
              ipv6Enabled: true,
            },
          ],
          sshKeys: [resolvedSshKeyName],
          ...(firewall
            ? {
                firewallIds: [firewall.id.apply((id) => Number(id))],
              }
            : {}),
          labels: {
            role: "mail",
            provider: "hetzner",
            stack: "mail",
            os: "bootstrap-linux",
          },
        },
        config.resourceOptions,
      ),
  )

  const ipv4RdnsRecord = yield* registerPulumiResource(
    resourceNames.ipv4Rdns,
    () =>
      new hcloud.Rdns(
        resourceNames.ipv4Rdns,
        {
          serverId: server.id.apply((id) => Number(id)),
          ipAddress: server.ipv4Address,
          dnsPtr: config.rdnsHostname,
        },
        config.resourceOptions,
      ),
  )

  return {
    server,
    firewall,
    ipv4RdnsRecord,
    serverType,
    location,
    image: imageName,
    sshKeyName: resolvedSshKeyName,
  }
})
