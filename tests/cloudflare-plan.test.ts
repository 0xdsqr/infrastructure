import { strict as assert } from "node:assert"
import { test } from "node:test"

import * as pulumi from "@pulumi/pulumi"
import { Effect } from "effect"

import {
  createCloudflareEdgeEffect,
  planCloudflareEdgeEffect,
  type CloudflareEdgeArgs,
  type CloudflareEdgePlanArgs,
} from "@dsqr/pulumi-cloudflare"
import { runPulumiProgram } from "@dsqr/pulumi-shared"

const validArgs = {
  accountId: "account-id",
  zoneIds: {
    primary: "zone-primary",
  },
  zones: {
    primary: "example.com",
  },
  zoneSecurity: {
    primary: {
      strictTransportSecurity: {
        includeSubdomains: false,
        maxAge: 300,
        preload: false,
      },
    },
  },
  tunnel: {
    name: "gateway",
    defaultService: "http_status:404",
  },
  ingressRules: [
    {
      hostname: "app.example.com",
      zone: "primary",
      service: "https://origin.example.internal",
    },
  ],
  dnsRecords: [
    {
      zone: "primary",
      name: "example.com",
      type: "TXT",
    },
  ],
  r2Buckets: [],
  accessApplications: [],
} as const satisfies CloudflareEdgePlanArgs

const plan = (overrides: Partial<CloudflareEdgePlanArgs> = {}) =>
  planCloudflareEdgeEffect({
    ...validArgs,
    ...overrides,
  })

const validCreationArgs = {
  ...validArgs,
  tunnelSecret: "mock-secret",
  dnsRecords: [
    {
      ...validArgs.dnsRecords[0],
      content: "deployment=production",
    },
  ],
} as const satisfies CloudflareEdgeArgs

test("Cloudflare preflight returns a deterministic resource plan", () => {
  const result = Effect.runSync(plan())

  assert.equal(result.tunnelResourceName, "gateway")
  assert.equal(result.tunnelConfigResourceName, "gateway-config")
  assert.deepEqual(
    result.ingressRules.map(({ logicalName, zoneId }) => ({ logicalName, zoneId })),
    [{ logicalName: "app-example-com", zoneId: "zone-primary" }],
  )
  assert.deepEqual(
    result.directRecords.map(({ logicalName, zoneId }) => ({ logicalName, zoneId })),
    [{ logicalName: "TXT-example-com", zoneId: "zone-primary" }],
  )
})

test("Cloudflare preflight rejects missing account, zone, and tunnel configuration", () => {
  assert.throws(() => Effect.runSync(plan({ accountId: " " })), /account id must not be empty/i)
  assert.throws(
    () =>
      Effect.runSync(
        plan({
          zoneIds: {
            primary: "",
          },
        }),
      ),
    /non-empty zone id/i,
  )
  assert.throws(
    () =>
      Effect.runSync(
        plan({
          tunnel: {
            name: "",
            defaultService: "http_status:404",
          },
        }),
      ),
    /tunnel name must not be empty/i,
  )
  assert.throws(
    () =>
      Effect.runSync(
        plan({
          tunnel: {
            name: "gateway",
            defaultService: "",
          },
        }),
      ),
    /default service must not be empty/i,
  )
})

test("Cloudflare preflight requires declared zones and explicit valid HSTS policies", () => {
  assert.throws(
    () =>
      Effect.runSync(
        plan({
          ingressRules: [
            {
              hostname: "app.example.com",
              zone: "missing",
              service: "https://origin.example.internal",
            },
          ],
        }),
      ),
    /unknown Cloudflare zone/i,
  )
  assert.throws(
    () =>
      Effect.runSync(
        plan({
          zoneSecurity: {},
        }),
      ),
    /explicit security policy/i,
  )

  for (const maxAge of [-1, 1.5]) {
    assert.throws(
      () =>
        Effect.runSync(
          plan({
            zoneSecurity: {
              primary: {
                strictTransportSecurity: {
                  includeSubdomains: false,
                  maxAge,
                  preload: false,
                },
              },
            },
          }),
        ),
      /non-negative integer/i,
    )
  }
})

test("Cloudflare preflight rejects duplicate hostnames, physical DNS records, and logical names", () => {
  assert.throws(
    () =>
      Effect.runSync(
        plan({
          ingressRules: [
            ...validArgs.ingressRules,
            {
              hostname: "APP.EXAMPLE.COM",
              zone: "primary",
              service: "https://other.example.internal",
            },
          ],
        }),
      ),
    /ingress hostnames must be unique/i,
  )
  assert.throws(
    () =>
      Effect.runSync(
        plan({
          dnsRecords: [
            ...validArgs.dnsRecords,
            {
              zone: "primary",
              name: "EXAMPLE.COM",
              type: "TXT",
            },
          ],
        }),
      ),
    /physical DNS identities.*must be unique/i,
  )
  assert.throws(
    () =>
      Effect.runSync(
        plan({
          ingressRules: [
            {
              ...validArgs.ingressRules[0],
              resourceName: "gateway",
            },
          ],
        }),
      ),
    /logical resource names must be unique/i,
  )
})

test("Cloudflare preflight rejects duplicate physical R2 and Access identities", () => {
  assert.throws(
    () =>
      Effect.runSync(
        plan({
          r2Buckets: [
            {
              name: "assets",
              resourceName: "assets-primary",
            },
            {
              name: "ASSETS",
              resourceName: "assets-secondary",
            },
          ],
        }),
      ),
    /R2 bucket names must be unique/i,
  )
  assert.throws(
    () =>
      Effect.runSync(
        plan({
          accessApplications: [
            {
              name: "Admin one",
              hostname: "admin.example.com",
              resourceName: "admin-primary",
              allowedEmails: ["one@example.com"],
            },
            {
              name: "Admin two",
              hostname: "ADMIN.EXAMPLE.COM",
              resourceName: "admin-secondary",
              allowedEmails: ["two@example.com"],
            },
          ],
        }),
      ),
    /Access application hostnames must be unique/i,
  )
})

test("Cloudflare preflight validates DNS TTL, proxying, priority, and static content", () => {
  const invalidRecords = [
    {
      record: {
        zone: "primary",
        name: "zero-ttl.example.com",
        type: "A",
        content: "192.0.2.1",
        ttl: 0,
      },
      error: /TTL must be a positive integer/i,
    },
    {
      record: {
        zone: "primary",
        name: "fractional-ttl.example.com",
        type: "A",
        content: "192.0.2.1",
        ttl: 1.5,
      },
      error: /TTL must be a positive integer/i,
    },
    {
      record: {
        zone: "primary",
        name: "example.com",
        type: "MX",
        content: "mail.example.com",
        priority: 10,
        proxied: true,
      },
      error: /type MX cannot be proxied/i,
    },
    {
      record: {
        zone: "primary",
        name: "txt.example.com",
        type: "TXT",
        content: "value",
        priority: 10,
      },
      error: /type TXT cannot declare priority/i,
    },
    {
      record: {
        zone: "primary",
        name: "example.com",
        type: "MX",
        content: "mail.example.com",
      },
      error: /needs an integer priority/i,
    },
    {
      record: {
        zone: "primary",
        name: "",
        type: "TXT",
        content: "value",
      },
      error: /names must not be empty/i,
    },
    {
      record: {
        zone: "primary",
        name: "empty.example.com",
        type: "TXT",
        content: " ",
      },
      error: /static content must not be empty/i,
    },
    {
      record: {
        zone: "primary",
        name: "bad-a.example.com",
        type: "A",
        content: "not-an-ipv4-address",
      },
      error: /A record.*malformed static content/i,
    },
    {
      record: {
        zone: "primary",
        name: "bad-cname.example.com",
        type: "CNAME",
        content: "https://target.example.com",
      },
      error: /CNAME record.*malformed static content/i,
    },
  ] as const

  for (const { error, record } of invalidRecords) {
    assert.throws(
      () =>
        Effect.runSync(
          plan({
            dnsRecords: [record],
          }),
        ),
      error,
    )
  }
})

test("Cloudflare creation registers no provider resources when preflight fails", async () => {
  let registrations = 0

  await pulumi.runtime.setMocks(
    {
      call: (args) => args.inputs,
      newResource: (args) => {
        if (args.type.startsWith("cloudflare:")) {
          registrations += 1
        }

        return {
          id: args.custom ? `${args.name}-id` : undefined,
          state: args.inputs,
        }
      },
    },
    "cloudflare-edge",
    "dev",
    true,
  )

  const invalidGraphs: ReadonlyArray<{
    readonly args: CloudflareEdgeArgs
    readonly error: RegExp
  }> = [
    {
      args: {
        ...validCreationArgs,
        dnsRecords: [
          {
            zone: "primary",
            name: "duplicate.example.com",
            type: "TXT",
            content: "one",
          },
          {
            zone: "primary",
            name: "DUPLICATE.EXAMPLE.COM",
            type: "TXT",
            content: "two",
          },
        ],
      },
      error: /physical DNS identities.*must be unique/i,
    },
    {
      args: {
        ...validCreationArgs,
        r2Buckets: [
          {
            name: "assets",
            resourceName: "assets-one",
          },
          {
            name: "assets",
            resourceName: "assets-two",
          },
        ],
      },
      error: /R2 bucket names must be unique/i,
    },
    {
      args: {
        ...validCreationArgs,
        accessApplications: [
          {
            name: "Admin one",
            hostname: "admin.example.com",
            resourceName: "admin-one",
            allowedEmails: ["one@example.com"],
          },
          {
            name: "Admin two",
            hostname: "admin.example.com",
            resourceName: "admin-two",
            allowedEmails: ["two@example.com"],
          },
        ],
      },
      error: /Access application hostnames must be unique/i,
    },
    {
      args: {
        ...validCreationArgs,
        dnsRecords: [
          {
            zone: "primary",
            name: "bad.example.com",
            type: "A",
            content: "not-an-address",
          },
        ],
      },
      error: /malformed static content/i,
    },
  ]

  for (const { args, error } of invalidGraphs) {
    const registrationsBefore = registrations

    assert.throws(() => runPulumiProgram(createCloudflareEdgeEffect(args)), error)
    assert.equal(registrations, registrationsBefore)
  }
  assert.equal(registrations, 0)
})
