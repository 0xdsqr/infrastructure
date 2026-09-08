import { strict as assert } from "node:assert"
import { test } from "node:test"

import { PulumiResourceConfigError } from "@dsqr/pulumi-shared"
import * as pulumi from "@pulumi/pulumi"
import type { MockResourceArgs } from "@pulumi/pulumi/runtime"
import { Effect } from "effect"

import {
  createTailscalePlatformEffect,
  validateTailscalePlatformArgs,
} from "../packages/pulumi/tailscale/src/index.ts"
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
      deviceTagSpecs: tailscale.deviceTagSpecs,
    }),
  )
  await resolveOutput(deployed.policy)
  const serverAuthKey = await resolveOutput(deployed.authKeys.homelabServer)
  const backupAuthKey = await resolveOutput(deployed.authKeys.homelabBackup)
  const mailAuthKey = await resolveOutput(deployed.authKeys.mailServer)
  const indigoAuthKey = await resolveOutput(deployed.authKeys.indigoNode)
  assert.deepEqual(await resolveOutput(deployed.deviceTags.indigoWorker03!), [
    tailscale.tags.cluster.indigoNode,
  ])
  for (const key of [
    "indigoWorker01",
    "indigoWorker02",
    "indigoControl01",
    "indigoControl02",
    "indigoControl03",
  ]) {
    assert.deepEqual(await resolveOutput(deployed.deviceTags[key]!), [
      tailscale.tags.cluster.indigoNode,
    ])
  }

  const registered = resources
    .filter((resource) => resource.type.startsWith("tailscale:"))
    .map((resource) => [resource.type, resource.name] as const)
    .sort((left, right) => left[1].localeCompare(right[1]))

  assert.deepEqual(registered, [
    ["tailscale:index/tailnetKey:TailnetKey", "cloud-mail-key"],
    ["tailscale:index/deviceTags:DeviceTags", "dsqr-indigo-control-01-tags"],
    ["tailscale:index/deviceTags:DeviceTags", "dsqr-indigo-control-02-tags"],
    ["tailscale:index/deviceTags:DeviceTags", "dsqr-indigo-control-03-tags"],
    ["tailscale:index/tailnetKey:TailnetKey", "dsqr-indigo-node-key"],
    ["tailscale:index/deviceTags:DeviceTags", "dsqr-indigo-worker-01-tags"],
    ["tailscale:index/deviceTags:DeviceTags", "dsqr-indigo-worker-02-tags"],
    ["tailscale:index/deviceTags:DeviceTags", "dsqr-indigo-worker-03-tags"],
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
  assert.equal(indigoAuthKey, "mock-dsqr-indigo-node-key")
  assert.equal(await deployed.authKeys.homelabServer.isSecret, true)
  assert.equal(await deployed.authKeys.homelabBackup.isSecret, true)
  assert.equal(await deployed.authKeys.mailServer.isSecret, true)
  assert.equal(await deployed.authKeys.indigoNode.isSecret, true)

  const indigoKey = resources.find((resource) => resource.name === "dsqr-indigo-node-key")
  assert.ok(indigoKey)
  assert.deepEqual(indigoKey.inputs, {
    description: "DSQR Indigo node bootstrap",
    reusable: true,
    ephemeral: false,
    preauthorized: true,
    expiry: 7_776_000,
    recreateIfInvalid: "always",
    tags: [tailscale.tags.cluster.indigoNode],
  })
  const workerTags = resources.find((resource) => resource.name === "dsqr-indigo-worker-03-tags")
  assert.ok(workerTags)
  assert.deepEqual(workerTags.inputs, {
    deviceId: "n35gDmGxvw11CNTRL",
    tags: ["tag:dsqr-indigo-node"],
  })
})

test("Tailscale rejects unsafe device-tag inventories before registering resources", async () => {
  const valid = { resourceName: "worker-tags", deviceId: "node-id", tags: ["tag:indigo"] }
  const inventories = [
    { worker: { ...valid, deviceId: " " } },
    { worker: { ...valid, resourceName: " " } },
    { worker: { ...valid, resourceName: "test-policy" } },
    { worker: { ...valid, tags: [] } },
    { worker: { ...valid, tags: ["indigo"] } },
    { worker: { ...valid, tags: ["tag:indigo", "tag:indigo"] } },
    { worker: valid, other: { ...valid, resourceName: "other-tags" } },
    { worker: valid, other: { ...valid, deviceId: "other-id" } },
  ]
  for (const deviceTagSpecs of inventories) {
    const resourceCount = resources.length
    const error = await Effect.runPromise(
      Effect.flip(
        createTailscalePlatformEffect({
          policyResourceName: "test-policy",
          policyDocument: {},
          keySpecs: {},
          deviceTagSpecs,
        }),
      ),
    )
    assert.ok(error instanceof PulumiResourceConfigError)
    assert.match(error.resource, /^tailscale:deviceTags:/)
    assert.equal(resources.length, resourceCount)
  }
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
      label: "description exceeds provider limit",
      args: {
        policyDocument: {},
        keySpecs: { test: { ...validKey, description: "x".repeat(51) } },
      },
      resource: "tailscale:key:test",
      message: /at most 50 characters/,
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

test("Tailscale accepts a description at the provider's 50-character boundary", async () => {
  await Effect.runPromise(
    validateTailscalePlatformArgs({
      policyResourceName: "test-policy",
      policyDocument: {},
      keySpecs: {
        test: {
          resourceName: "test-key",
          description: "x".repeat(50),
          tags: ["tag:test"],
        },
      },
    }),
  )
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
