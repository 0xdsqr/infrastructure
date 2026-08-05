import { strict as assert } from "node:assert"
import { test } from "node:test"

import { PulumiResourceConfigError } from "@dsqr/pulumi-shared"
import * as pulumi from "@pulumi/pulumi"
import type { MockResourceArgs } from "@pulumi/pulumi/runtime"
import { Effect } from "effect"

import { createTailscalePlatformEffect } from "../packages/pulumi/tailscale/src/index.ts"
import { tailscale, tailscaleAdminUser } from "../infra/tailscale/config.ts"

const resources: Array<MockResourceArgs> = []

await pulumi.runtime.setMocks(
  {
    call: (args) => args.inputs,
    newResource: (args) => {
      resources.push(args)

      return {
        id: `${args.name}-id`,
        state: {
          ...args.inputs,
          key: `mock-${args.name}`,
        },
      }
    },
  },
  "infrastructure",
  "dev",
  true,
)

const resolveOutput = <Value>(output: pulumi.Output<Value>) =>
  (
    output as unknown as {
      promise(): Promise<Value>
    }
  ).promise()

test("Tailscale infrastructure manages its policy and rotating server bootstrap key", async () => {
  const deployed = Effect.runSync(
    createTailscalePlatformEffect({
      policyResourceName: tailscale.policyResourceName,
      policyDocument: tailscale.createPolicy({
        adminUser: tailscaleAdminUser,
      }),
      keySpecs: tailscale.keySpecs,
    }),
  )
  await resolveOutput(deployed.policy)
  const serverAuthKey = await resolveOutput(deployed.authKeys.homelabServer)
  const backupAuthKey = await resolveOutput(deployed.authKeys.homelabBackup)
  const mailAuthKey = await resolveOutput(deployed.authKeys.mailServer)

  const registered = resources
    .filter((resource) => resource.type.startsWith("tailscale:"))
    .map((resource) => [resource.type, resource.name] as const)
    .sort((left, right) => left[1].localeCompare(right[1]))

  assert.deepEqual(registered, [
    ["tailscale:index/tailnetKey:TailnetKey", "cloud-mail-key"],
    ["tailscale:index/tailnetKey:TailnetKey", "homelab-backup-key"],
    ["tailscale:index/tailnetKey:TailnetKey", "homelab-server-key"],
    ["tailscale:index/acl:Acl", "tailnet-policy"],
  ])

  const policy = resources.find((resource) => resource.name === tailscale.policyResourceName)
  assert.ok(policy)
  assert.equal(policy.provider, "")
  assert.deepEqual(policy.inputs, {
    acl: JSON.stringify(tailscale.createPolicy({ adminUser: tailscaleAdminUser }), null, 2),
    overwriteExistingContent: false,
    resetAclOnDestroy: false,
  })

  const serverKey = resources.find((resource) => resource.name === "homelab-server-key")
  assert.ok(serverKey)
  assert.deepEqual(serverKey.inputs, {
    description: "Reusable bootstrap enrollment for homelab servers",
    reusable: true,
    ephemeral: false,
    preauthorized: true,
    expiry: 7_776_000,
    recreateIfInvalid: "always",
    tags: [tailscale.tags.location.homelab, tailscale.tags.role.server],
  })

  assert.equal(serverAuthKey, "mock-homelab-server-key")
  assert.equal(backupAuthKey, "mock-homelab-backup-key")
  assert.equal(mailAuthKey, "mock-cloud-mail-key")
  assert.equal(await deployed.authKeys.homelabServer.isSecret, true)
  assert.equal(await deployed.authKeys.homelabBackup.isSecret, true)
  assert.equal(await deployed.authKeys.mailServer.isSecret, true)
})

test("Tailscale generic key specs reject duplicate logical names before registration", async () => {
  const resourceCount = resources.length

  const error = await Effect.runPromise(
    Effect.flip(
      createTailscalePlatformEffect({
        policyResourceName: "test-policy",
        policyDocument: {},
        keySpecs: {
          first: {
            resourceName: "duplicate-key",
            description: "first",
            tags: ["tag:first"],
          },
          second: {
            resourceName: "duplicate-key",
            description: "second",
            tags: ["tag:second"],
          },
        },
      }),
    ),
  )

  assert.ok(error instanceof PulumiResourceConfigError)
  assert.equal(error.resource, "tailscale:key:second")
  assert.match(error.message, /must be unique/)
  assert.equal(resources.length, resourceCount)
})

test("Tailscale validates policy and key metadata before registration", async () => {
  const validKey = {
    resourceName: "test-key",
    description: "test key",
    tags: ["tag:test"],
  } as const

  const invalidInputs = [
    {
      label: "array policy",
      args: {
        policyDocument: [],
        keySpecs: { test: validKey },
      },
      resource: "tailscale:policyDocument",
      message: /JSON object/,
    },
    {
      label: "empty description",
      args: {
        policyDocument: {},
        keySpecs: { test: { ...validKey, description: " " } },
      },
      resource: "tailscale:key:test",
      message: /description/,
    },
    {
      label: "no tags",
      args: {
        policyDocument: {},
        keySpecs: { test: { ...validKey, tags: [] } },
      },
      resource: "tailscale:key:test",
      message: /at least one tag/,
    },
    {
      label: "invalid tag",
      args: {
        policyDocument: {},
        keySpecs: { test: { ...validKey, tags: ["server"] } },
      },
      resource: "tailscale:key:test",
      message: /tag:<name>/,
    },
    {
      label: "duplicate tag",
      args: {
        policyDocument: {},
        keySpecs: { test: { ...validKey, tags: ["tag:test", "tag:test"] } },
      },
      resource: "tailscale:key:test",
      message: /must be unique/,
    },
  ] as const

  for (const invalid of invalidInputs) {
    const resourceCount = resources.length
    const error = await Effect.runPromise(
      Effect.flip(
        createTailscalePlatformEffect({
          policyResourceName: "test-policy",
          ...invalid.args,
        }),
      ),
    )

    assert.ok(error instanceof PulumiResourceConfigError, invalid.label)
    assert.equal(error.resource, invalid.resource, invalid.label)
    assert.match(error.message, invalid.message, invalid.label)
    assert.equal(resources.length, resourceCount, invalid.label)
  }
})

test("Tailscale catches policy serialization failures before registration", async () => {
  const policy: Record<string, unknown> = {}
  policy.self = policy
  const resourceCount = resources.length

  const error = await Effect.runPromise(
    Effect.flip(
      createTailscalePlatformEffect({
        policyResourceName: "test-policy",
        policyDocument: policy,
        keySpecs: {
          test: {
            resourceName: "test-key",
            description: "test key",
            tags: ["tag:test"],
          },
        },
      }),
    ),
  )

  assert.ok(error instanceof PulumiResourceConfigError)
  assert.equal(error.resource, "tailscale:policyDocument")
  assert.match(error.message, /JSON serializable/)
  assert.equal(resources.length, resourceCount)
})

test("Tailscale rejects lossy JSON policy values before registration", async () => {
  const invalidValues = [undefined, () => "ignored", Number.NaN, Number.POSITIVE_INFINITY] as const

  for (const invalidValue of invalidValues) {
    const resourceCount = resources.length
    const error = await Effect.runPromise(
      Effect.flip(
        createTailscalePlatformEffect({
          policyResourceName: "test-policy",
          policyDocument: { grants: [invalidValue] } as never,
          keySpecs: {
            test: {
              resourceName: "test-key",
              description: "test key",
              tags: ["tag:test"],
            },
          },
        }),
      ),
    )

    assert.ok(error instanceof PulumiResourceConfigError)
    assert.equal(error.resource, "tailscale:policyDocument")
    assert.match(error.message, /without lossy values/)
    assert.equal(resources.length, resourceCount)
  }
})
