import { strict as assert } from "node:assert"
import { test } from "node:test"

import { createCloudflareEdgeEffect } from "@dsqr/pulumi-cloudflare"
import { runPulumiProgram } from "@dsqr/pulumi-shared"

import { cloudflare } from "../infra/cloudflare/config.ts"
import { byName, runPulumiMockProgram } from "./pulumi-state-helpers.ts"

const tunnelToken = "cloudflare:index/zeroTrustTunnelCloudflared:ZeroTrustTunnelCloudflared"
const tunnelConfigToken =
  "cloudflare:index/zeroTrustTunnelCloudflaredConfig:ZeroTrustTunnelCloudflaredConfig"
const dnsToken = "cloudflare:index/dnsRecord:DnsRecord"
const zoneSettingToken = "cloudflare:index/zoneSetting:ZoneSetting"
const r2BucketToken = "cloudflare:index/r2Bucket:R2Bucket"
const r2BucketLockToken = "cloudflare:index/r2BucketLock:R2BucketLock"
const tunnelTokenInvoke =
  "cloudflare:index/getZeroTrustTunnelCloudflaredToken:getZeroTrustTunnelCloudflaredToken"

const zoneIds = {
  dsqrDev: "zone-dsqr",
  fidaraIo: "zone-fidara",
  tastingswithtayCom: "zone-twt",
} as const

const rootOptionsAreStable = (deployment: Awaited<ReturnType<typeof deploy>>, name: string) => {
  const resource = byName(deployment.captured, name)
  assert.equal(resource.opts.parent, undefined)
  assert.equal(resource.opts.provider, undefined)
  assert.equal(resource.opts.dependsOn, undefined)
  assert.equal(resource.opts.protect, undefined)
  assert.equal(resource.opts.retainOnDelete, undefined)
  assert.equal(resource.opts.ignoreChanges, undefined)
}

const deploy = () =>
  runPulumiMockProgram({
    program: () =>
      runPulumiProgram(
        createCloudflareEdgeEffect({
          accountId: "account-id",
          tunnelSecret: "mock-tunnel-secret",
          zoneIds,
          zones: cloudflare.zones,
          zoneSecurity: cloudflare.zoneSecurity,
          tunnel: cloudflare.tunnel,
          ingressRules: cloudflare.ingressRules,
          dnsRecords: [
            {
              zone: "dsqrDev",
              name: cloudflare.mailHostname,
              type: "A",
              content: "203.0.113.10",
              proxied: false,
              ttl: 1,
            },
            ...cloudflare.dnsRecords,
          ],
          r2Buckets: cloudflare.r2Buckets,
        }),
      ),
    outputs: (result) => ({
      tunnelId: result.tunnelId,
      tunnelToken: result.tunnelToken,
      configVersion: result.configVersion,
    }),
    call: (call) =>
      call.token === tunnelTokenInvoke
        ? {
            token: "mock-token",
          }
        : call.inputs,
    project: "cloudflare-edge",
  })

test("Cloudflare preserves tunnel, DNS, and zone-security state identities", async () => {
  const deployment = await deploy()
  const resources = deployment.resources.filter((resource) =>
    resource.type.startsWith("cloudflare:"),
  )

  assert.equal(resources.length, 35)
  assert.deepEqual(
    resources
      .map((resource) => [resource.type, resource.name] as const)
      .sort((left, right) => left[1].localeCompare(right[1])),
    [
      [dnsToken, "A-mx-dsqr-dev"],
      [dnsToken, "MX-dsqr-dev"],
      [dnsToken, "TXT-dmarc-dsqr-dev"],
      [dnsToken, "TXT-dsqr-dev"],
      [dnsToken, "TXT-ed25519-domainkey-dsqr-dev"],
      [dnsToken, "TXT-rsa-domainkey-dsqr-dev"],
      [dnsToken, "admin-tastingswithtay-com"],
      [dnsToken, "api-fidara-io"],
      [dnsToken, "argocd-hooks-hub-a-dsqr-dev"],
      [dnsToken, "cdn-dsqr-dev"],
      [dnsToken, "dsqr-dev"],
      [zoneSettingToken, "dsqrDev-always-use-https"],
      [zoneSettingToken, "dsqrDev-automatic-https-rewrites"],
      [zoneSettingToken, "dsqrDev-min-tls-version"],
      [zoneSettingToken, "dsqrDev-ssl"],
      [zoneSettingToken, "dsqrDev-tls-1-3"],
      [dnsToken, "fidara-io"],
      [zoneSettingToken, "fidaraIo-always-use-https"],
      [zoneSettingToken, "fidaraIo-automatic-https-rewrites"],
      [zoneSettingToken, "fidaraIo-min-tls-version"],
      [zoneSettingToken, "fidaraIo-ssl"],
      [zoneSettingToken, "fidaraIo-tls-1-3"],
      [tunnelToken, "gateway"],
      [tunnelConfigToken, "gateway-config"],
      [r2BucketToken, "homelab-backups"],
      [r2BucketLockToken, "homelab-backups-lock"],
      [dnsToken, "labs-dsqr-dev"],
      [dnsToken, "s3-dsqr-dev"],
      [dnsToken, "studio-dsqr-dev"],
      [dnsToken, "tastingswithtay-com"],
      [zoneSettingToken, "tastingswithtayCom-always-use-https"],
      [zoneSettingToken, "tastingswithtayCom-automatic-https-rewrites"],
      [zoneSettingToken, "tastingswithtayCom-min-tls-version"],
      [zoneSettingToken, "tastingswithtayCom-ssl"],
      [zoneSettingToken, "tastingswithtayCom-tls-1-3"],
    ].sort((left, right) => left[1].localeCompare(right[1])),
  )

  for (const resource of resources) {
    if (resource.name === "homelab-backups" || resource.name === "homelab-backups-lock") {
      assert.equal(byName(deployment.captured, resource.name).opts.protect, true)
    } else {
      rootOptionsAreStable(deployment, resource.name)
    }
    assert.equal(resource.provider, "")
  }

  const backupBucket = byName(resources, "homelab-backups")
  assert.deepEqual(backupBucket.inputs, {
    accountId: "account-id",
    jurisdiction: "default",
    location: "enam",
    name: "dsqr-homelab-backups",
    storageClass: "Standard",
  })

  const backupLock = byName(resources, "homelab-backups-lock")
  assert.deepEqual(backupLock.inputs, {
    accountId: "account-id",
    bucketName: "dsqr-homelab-backups",
    jurisdiction: "default",
    rules: [
      {
        condition: {
          maxAgeSeconds: 2_592_000,
          type: "Age",
        },
        enabled: true,
        id: "retain-all-objects",
        prefix: "",
      },
    ],
  })

  const tunnel = byName(resources, "gateway")
  assert.equal(tunnel.inputs.accountId, "account-id")
  assert.equal(tunnel.inputs.name, "gateway")
  assert.equal(tunnel.inputs.configSrc, "cloudflare")

  const config = byName(resources, "gateway-config")
  assert.equal(config.inputs.accountId, "account-id")
  assert.equal(config.inputs.source, "cloudflare")
  assert.deepEqual(config.inputs.config.ingresses, [
    ...cloudflare.ingressRules.map((rule) => ({
      hostname: rule.hostname,
      service: rule.service,
      ...(rule.originRequest ? { originRequest: rule.originRequest } : {}),
    })),
    { service: "http_status:404" },
  ])

  const ingressRecords = cloudflare.ingressRules.map((rule) =>
    byName(resources, rule.hostname.replace(/[^a-zA-Z0-9]+/g, "-")),
  )
  for (const record of ingressRecords) {
    assert.equal(record.inputs.type, "CNAME")
    assert.equal(record.inputs.proxied, true)
    assert.equal(record.inputs.ttl, 1)
    assert.match(record.inputs.content, /\.cfargotunnel\.com$/)
  }

  const mail = byName(resources, "A-mx-dsqr-dev")
  assert.deepEqual(
    {
      zoneId: mail.inputs.zoneId,
      name: mail.inputs.name,
      type: mail.inputs.type,
      content: mail.inputs.content,
      proxied: mail.inputs.proxied,
      ttl: mail.inputs.ttl,
    },
    {
      zoneId: "zone-dsqr",
      name: "mx.dsqr.dev",
      type: "A",
      content: "203.0.113.10",
      proxied: false,
      ttl: 1,
    },
  )

  const strictTls = byName(resources, "dsqrDev-ssl")
  assert.deepEqual(strictTls.inputs, {
    settingId: "ssl",
    value: "strict",
    zoneId: "zone-dsqr",
  })
  assert.deepEqual(
    deployment.calls.map((call) => call.token),
    [tunnelTokenInvoke],
  )
})
