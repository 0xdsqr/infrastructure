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

test("Tailscale infrastructure preserves every live logical name and setting", async () => {
  const deployed = Effect.runSync(
    createTailscalePlatformEffect({
      policyResourceName: tailscale.policyResourceName,
      policyDocument: tailscale.createPolicy({
        adminUser: tailscaleAdminUser,
      }),
      keySpecs: tailscale.keySpecs,
    }),
  )
  const authKeys = deployed.authKeys

  await Promise.all([resolveOutput(deployed.policy), ...Object.values(authKeys).map(resolveOutput)])

  const registered = resources
    .filter((resource) => resource.type.startsWith("tailscale:"))
    .map((resource) => [resource.type, resource.name] as const)
    .sort((left, right) => left[1].localeCompare(right[1]))

  assert.deepEqual(registered, [
    ["tailscale:index/tailnetKey:TailnetKey", "aws-server-key"],
    ["tailscale:index/tailnetKey:TailnetKey", "hetzner-mail-key"],
    ["tailscale:index/tailnetKey:TailnetKey", "homelab-backup-key"],
    ["tailscale:index/tailnetKey:TailnetKey", "homelab-server-key"],
    ["tailscale:index/tailnetKey:TailnetKey", "opnsense-exit-node-key"],
    ["tailscale:index/tailnetKey:TailnetKey", "proxmox-control-plane-key"],
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

  for (const [key, spec] of Object.entries(tailscale.keySpecs)) {
    const resource = resources.find((candidate) => candidate.name === spec.resourceName)
    assert.ok(resource, `missing ${spec.resourceName}`)
    assert.equal(resource.provider, "")
    assert.deepEqual(resource.inputs, {
      description: spec.description,
      ephemeral: false,
      expiry: 3_600,
      preauthorized: false,
      recreateIfInvalid: "never",
      reusable: false,
      tags: [...spec.tags],
    })
    assert.equal(
      await resolveOutput(authKeys[key as keyof typeof authKeys]),
      `mock-${spec.resourceName}`,
    )
    assert.equal(await pulumi.isSecret(authKeys[key as keyof typeof authKeys]), true)
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
