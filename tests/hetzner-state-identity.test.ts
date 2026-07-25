import { strict as assert } from "node:assert"
import { test } from "node:test"

import {
  createHetznerMailServerEffect,
  isValidHostOrCidr,
  isValidRdnsHostname,
  validateHetznerMailServerConfig,
} from "@dsqr/pulumi-hetzner"
import { PulumiResourceConfigError, runPulumiProgram } from "@dsqr/pulumi-shared"
import { Effect } from "effect"

import { hetznerMail } from "../infra/hetzner/config.ts"
import { byName, runPulumiMockProgram } from "./pulumi-state-helpers.ts"

const firewallToken = "hcloud:index/firewall:Firewall"
const serverToken = "hcloud:index/server:Server"
const rdnsToken = "hcloud:index/rdns:Rdns"
const sshKeyInvoke = "hcloud:index/getSshKey:getSshKey"
const imageInvoke = "hcloud:index/getImage:getImage"

test("Hetzner preserves mail-server identities, relationships, and perimeter inputs", async () => {
  const deployment = await runPulumiMockProgram({
    program: () => runPulumiProgram(createHetznerMailServerEffect(hetznerMail)),
    outputs: (result) => ({
      serverId: result.server.id,
      serverIpv4: result.server.ipv4Address,
      rdns: result.ipv4RdnsRecord.dnsPtr,
    }),
    call: (call) => {
      if (call.token === sshKeyInvoke) {
        return { name: "dsqr-homelab" }
      }
      if (call.token === imageInvoke) {
        return { name: "ubuntu-24.04" }
      }
      return call.inputs
    },
    newResource: (resource) =>
      resource.type === serverToken
        ? {
            ipv4Address: "203.0.113.10",
            ipv6Address: "2001:db8::10",
          }
        : {},
    newResourceId: (resource) => {
      if (!resource.custom) {
        return undefined
      }
      if (resource.type === firewallToken) {
        return "100"
      }
      if (resource.type === serverToken) {
        return "200"
      }
      return "300"
    },
    project: "hetzner-mail",
  })

  const resources = deployment.resources.filter((resource) => resource.type.startsWith("hcloud:"))
  assert.deepEqual(
    resources
      .map((resource) => [resource.type, resource.name] as const)
      .sort((left, right) => left[1].localeCompare(right[1])),
    [
      [firewallToken, "mail-firewall"],
      [rdnsToken, "mail-ipv4-rdns"],
      [serverToken, "mail-vps"],
    ],
  )

  for (const resource of resources) {
    const captured = byName(deployment.captured, resource.name)
    assert.equal(resource.provider, "")
    assert.equal(captured.opts.parent, undefined)
    assert.equal(captured.opts.provider, undefined)
    assert.equal(captured.opts.dependsOn, undefined)
    assert.equal(captured.opts.protect, undefined)
    assert.equal(captured.opts.retainOnDelete, undefined)
    assert.equal(captured.opts.ignoreChanges, undefined)
  }

  const firewall = byName(resources, "mail-firewall")
  assert.equal(firewall.inputs.name, "mail-vps-ssh")
  assert.deepEqual(firewall.inputs.labels, {
    provider: "hetzner",
    role: "mail",
    stack: "mail",
  })
  assert.deepEqual(
    firewall.inputs.rules.map(
      (rule: { readonly port: string; readonly sourceIps: ReadonlyArray<string> }) => [
        rule.port,
        rule.sourceIps,
      ],
    ),
    [
      ["22", ["98.156.203.63/32"]],
      ["22", ["2603:8080:7000:4c14:7400:4c92:47a4:6f56/128"]],
      ["25", ["0.0.0.0/0", "::/0"]],
      ["80", ["0.0.0.0/0", "::/0"]],
      ["443", ["0.0.0.0/0", "::/0"]],
      ["465", ["0.0.0.0/0", "::/0"]],
      ["587", ["0.0.0.0/0", "::/0"]],
      ["993", ["0.0.0.0/0", "::/0"]],
      ["4190", ["0.0.0.0/0", "::/0"]],
    ],
  )

  const server = byName(resources, "mail-vps")
  assert.deepEqual(
    {
      name: server.inputs.name,
      serverType: server.inputs.serverType,
      location: server.inputs.location,
      image: server.inputs.image,
      backups: server.inputs.backups,
      deleteProtection: server.inputs.deleteProtection,
      rebuildProtection: server.inputs.rebuildProtection,
      keepDisk: server.inputs.keepDisk,
      publicNets: server.inputs.publicNets,
      sshKeys: server.inputs.sshKeys,
      firewallIds: server.inputs.firewallIds,
    },
    {
      name: "mail-vps",
      serverType: "cpx11",
      location: "ash",
      image: "ubuntu-24.04",
      backups: false,
      deleteProtection: false,
      rebuildProtection: false,
      keepDisk: true,
      publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
      sshKeys: ["dsqr-homelab"],
      firewallIds: [100],
    },
  )

  const rdns = byName(resources, "mail-ipv4-rdns")
  assert.deepEqual(rdns.inputs, {
    dnsPtr: "mx.dsqr.dev",
    ipAddress: "203.0.113.10",
    serverId: 200,
  })

  assert.deepEqual(
    deployment.calls.map((call) => [call.token, call.inputs]),
    [
      [sshKeyInvoke, { name: "dsqr-homelab" }],
      [imageInvoke, { name: "ubuntu-24.04", withArchitecture: "x86" }],
    ],
  )
})

test("Hetzner validates IPv4, IPv6, CIDR, and reverse-DNS inputs", () => {
  assert.equal(isValidHostOrCidr("198.51.100.10", "ipv4"), true)
  assert.equal(isValidHostOrCidr("198.51.100.0/24", "ipv4"), true)
  assert.equal(isValidHostOrCidr("198.51.100.999", "ipv4"), false)
  assert.equal(isValidHostOrCidr("198.51.100.0/33", "ipv4"), false)
  assert.equal(isValidHostOrCidr("2001:db8::10", "ipv6"), true)
  assert.equal(isValidHostOrCidr("2001:db8::/64", "ipv6"), true)
  assert.equal(isValidHostOrCidr("2001:db8::/129", "ipv6"), false)
  assert.equal(isValidHostOrCidr("fe80::1%eth0", "ipv6"), false)
  assert.equal(isValidHostOrCidr("198.51.100.10", "ipv6"), false)

  assert.equal(isValidRdnsHostname("mx.dsqr.dev"), true)
  assert.equal(isValidRdnsHostname("mx.dsqr.dev."), true)
  assert.equal(isValidRdnsHostname("mx..dsqr.dev"), false)
  assert.equal(isValidRdnsHostname("-mx.dsqr.dev"), false)
  assert.equal(isValidRdnsHostname("198.51.100.10"), false)
})

test("Hetzner rejects malformed and empty configuration before provider calls", async () => {
  const invalidInputs = [
    ["name", { name: " " }],
    ["serverType", { serverType: "" }],
    ["location", { location: "" }],
    ["image", { image: "" }],
    ["sshKeyName", { sshKeyName: "" }],
    ["adminIpv4", { adminIpv4: "198.51.100.999" }],
    ["adminIpv6", { adminIpv6: "2001:db8::/129" }],
    ["rdnsHostname", { rdnsHostname: "not a hostname" }],
  ] as const

  for (const [field, override] of invalidInputs) {
    const error = await Effect.runPromise(
      Effect.flip(
        validateHetznerMailServerConfig({
          ...hetznerMail,
          ...override,
        }),
      ),
    )

    assert.ok(error instanceof PulumiResourceConfigError, field)
    assert.equal(error.resource, `hetzner-mail:${field}`, field)
  }
})

test("Hetzner enables the managed firewall by default and requires an explicit safe perimeter", async () => {
  const { createFirewall } = await Effect.runPromise(
    validateHetznerMailServerConfig({
      ...hetznerMail,
      createFirewall: undefined,
    }),
  )
  assert.equal(createFirewall, true)

  const error = await Effect.runPromise(
    Effect.flip(
      validateHetznerMailServerConfig({
        ...hetznerMail,
        createFirewall: undefined,
        adminIpv4: undefined,
        adminIpv6: undefined,
      }),
    ),
  )
  assert.ok(error instanceof PulumiResourceConfigError)
  assert.equal(error.resource, "hetzner-mail:firewall")

  const explicitlyUnmanaged = await Effect.runPromise(
    validateHetznerMailServerConfig({
      ...hetznerMail,
      createFirewall: false,
      adminIpv4: undefined,
      adminIpv6: undefined,
    }),
  )
  assert.equal(explicitlyUnmanaged.createFirewall, false)
})
