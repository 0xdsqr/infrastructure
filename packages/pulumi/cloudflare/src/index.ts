import * as cloudflare from "@pulumi/cloudflare"
import * as pulumi from "@pulumi/pulumi"
import { isIP } from "node:net"
import { Effect } from "effect"
import {
  PulumiResourceConfigError,
  registerPulumiResource,
  requireResourceConfigEffect,
} from "@dsqr/pulumi-shared"

export type CloudflareIngressRule = {
  readonly resourceName?: string
  readonly hostname: string
  readonly zone: string
  readonly service: string
  readonly insecureOriginReason?: string
  readonly originRequest?: {
    readonly http2Origin?: boolean
    readonly httpHostHeader?: string
    readonly originServerName?: string
  }
}

export type CloudflareDnsRecord = {
  readonly resourceName?: string
  readonly zone: string
  readonly name: string
  readonly type: "A" | "AAAA" | "CNAME" | "MX" | "TXT"
  readonly content: string
  readonly proxied?: boolean
  readonly ttl?: number
  readonly priority?: number
}

export type CloudflareR2Bucket = {
  readonly resourceName?: string
  readonly name: string
  readonly location?: "apac" | "eeur" | "enam" | "weur" | "wnam" | "oc"
  readonly jurisdiction?: "default" | "eu" | "fedramp"
  readonly storageClass?: "Standard" | "InfrequentAccess"
}

export type CloudflareAccessApplication = {
  readonly resourceName?: string
  readonly name: string
  readonly hostname: string
  readonly allowedEmails: ReadonlyArray<string>
  readonly sessionDuration?: string
}

export type CloudflareZoneSecurityPolicy = {
  readonly strictTransportSecurity: {
    readonly includeSubdomains: boolean
    readonly maxAge: number
    readonly preload: boolean
  }
}

export type CloudflareEdgeArgs = {
  readonly accountId: string
  readonly tunnelSecret: pulumi.Input<string>
  readonly zoneIds: Readonly<Record<string, string>>
  readonly zones: Readonly<Record<string, string>>
  readonly zoneSecurity: Readonly<Record<string, CloudflareZoneSecurityPolicy>>
  readonly tunnel: {
    readonly name: string
    readonly defaultService: string
  }
  readonly resourceNames?: {
    readonly tunnel?: string
    readonly tunnelConfig?: string
  }
  readonly resourceOptions?: pulumi.CustomResourceOptions
  readonly dnsRecords?: ReadonlyArray<
    Omit<CloudflareDnsRecord, "content"> & {
      readonly content: pulumi.Input<string>
    }
  >
  readonly r2Buckets?: ReadonlyArray<CloudflareR2Bucket>
  readonly accessApplications?: ReadonlyArray<CloudflareAccessApplication>
  readonly ingressRules: ReadonlyArray<CloudflareIngressRule>
}

export type CloudflareDnsRecordPlan = Omit<CloudflareDnsRecord, "content"> & {
  /**
   * Static content is validated during planning. It may be omitted when a
   * stack entrypoint has not constructed its dynamic Pulumi input yet.
   */
  readonly content?: pulumi.Input<string>
}

export type CloudflareEdgePlanArgs<
  DirectRecord extends CloudflareDnsRecordPlan = CloudflareDnsRecordPlan,
> = Omit<CloudflareEdgeArgs, "dnsRecords" | "tunnelSecret"> & {
  readonly dnsRecords?: ReadonlyArray<DirectRecord>
}

export type CloudflareEdgePlan<
  DirectRecord extends CloudflareDnsRecordPlan = CloudflareDnsRecordPlan,
> = {
  readonly tunnelResourceName: string
  readonly tunnelConfigResourceName: string
  readonly ingressRules: ReadonlyArray<{
    readonly rule: CloudflareIngressRule
    readonly zoneId: string
    readonly logicalName: string
  }>
  readonly directRecords: ReadonlyArray<{
    readonly record: DirectRecord
    readonly zoneId: string
    readonly logicalName: string
  }>
  readonly zoneSecurityPolicies: ReadonlyArray<{
    readonly zone: string
    readonly zoneId: string
    readonly policy: CloudflareZoneSecurityPolicy
  }>
  readonly r2Buckets: ReadonlyArray<{
    readonly bucket: CloudflareR2Bucket
    readonly logicalName: string
  }>
  readonly accessApplications: ReadonlyArray<{
    readonly application: CloudflareAccessApplication
    readonly logicalName: string
  }>
}

export function cloudflareZoneSecuritySettings(policy: CloudflareZoneSecurityPolicy) {
  return {
    alwaysUseHttps: {
      settingId: "always_use_https",
      value: "on",
    },
    automaticHttpsRewrites: {
      settingId: "automatic_https_rewrites",
      value: "on",
    },
    minimumTlsVersion: {
      settingId: "min_tls_version",
      value: "1.2",
    },
    tls13: {
      settingId: "tls_1_3",
      value: "on",
    },
    strictOriginTls: {
      settingId: "ssl",
      value: "strict",
    },
    strictTransportSecurity: {
      settingId: "security_header",
      value: {
        strictTransportSecurity: {
          enabled: true,
          includeSubdomains: policy.strictTransportSecurity.includeSubdomains,
          maxAge: policy.strictTransportSecurity.maxAge,
          nosniff: true,
          preload: policy.strictTransportSecurity.preload,
        },
      },
    },
  } as const
}

function resourceName(hostname: string) {
  return hostname
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "")
}

const logicalResourceName = (explicit: string | undefined, fallback: string) =>
  explicit ?? resourceName(fallback)

function requireZoneEffect(
  args: Pick<CloudflareEdgePlanArgs, "zoneIds" | "zones">,
  zone: string,
  resource: string,
): Effect.Effect<string, PulumiResourceConfigError> {
  if (!Object.hasOwn(args.zones, zone)) {
    return Effect.fail(
      new PulumiResourceConfigError({
        resource,
        message: `Unknown Cloudflare zone "${zone}". Declare it in zones before referencing it.`,
      }),
    )
  }

  const zoneId = args.zoneIds[zone]

  if (zoneId?.trim()) {
    return Effect.succeed(zoneId)
  }

  return Effect.fail(
    new PulumiResourceConfigError({
      resource,
      message: `Missing Cloudflare zone id for zone "${zone}".`,
    }),
  )
}

const physicalDnsIdentity = (zone: string, type: string, name: string) =>
  JSON.stringify([zone.trim().toLowerCase(), type.trim().toUpperCase(), name.trim().toLowerCase()])

function validateUniqueValuesEffect(
  values: ReadonlyArray<string>,
  resource: string,
  label: string,
): Effect.Effect<void, PulumiResourceConfigError> {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index)

  return requireResourceConfigEffect(
    duplicate === undefined,
    resource,
    duplicate === undefined
      ? `${label} are unique.`
      : `${label} must be unique; duplicate "${duplicate}".`,
  )
}

function isPrivateHttpOrigin(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase()

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true
  }

  const addressFamily = isIP(normalized)
  if (addressFamily === 4) {
    const octets = normalized.split(".").map(Number)
    const first = octets[0]
    const second = octets[1]

    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
  }

  if (addressFamily === 6) {
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
  }

  return normalized.endsWith(".home.arpa")
}

function isDnsHostname(value: string) {
  const hostname = value.endsWith(".") ? value.slice(0, -1) : value

  return (
    hostname.length > 0 &&
    hostname.length <= 253 &&
    hostname
      .split(".")
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
      )
  )
}

export function validateCloudflareDnsRecordEffect(
  record: CloudflareDnsRecordPlan,
): Effect.Effect<void, PulumiResourceConfigError> {
  const resource = `dns:${record.type}:${record.name}`

  return Effect.gen(function* () {
    yield* requireResourceConfigEffect(
      record.name.trim().length > 0,
      resource,
      "Cloudflare DNS record names must not be empty.",
    )
    yield* requireResourceConfigEffect(
      record.ttl === undefined || (Number.isInteger(record.ttl) && record.ttl > 0),
      resource,
      `Cloudflare DNS record "${record.name}" TTL must be a positive integer.`,
    )
    yield* requireResourceConfigEffect(
      record.proxied !== true || ["A", "AAAA", "CNAME"].includes(record.type),
      resource,
      `Cloudflare DNS record type ${record.type} cannot be proxied.`,
    )
    yield* requireResourceConfigEffect(
      record.proxied !== true || record.ttl === undefined || record.ttl === 1,
      resource,
      `Proxied Cloudflare DNS record "${record.name}" must use automatic TTL 1.`,
    )
    yield* requireResourceConfigEffect(
      record.type === "MX"
        ? Number.isInteger(record.priority) &&
            record.priority !== undefined &&
            record.priority >= 0 &&
            record.priority <= 65_535
        : record.priority === undefined,
      resource,
      record.type === "MX"
        ? `Cloudflare MX record "${record.name}" needs an integer priority from 0 through 65535.`
        : `Cloudflare DNS record type ${record.type} cannot declare priority.`,
    )

    if (typeof record.content !== "string") {
      return
    }

    const content = record.content.trim()
    yield* requireResourceConfigEffect(
      content.length > 0,
      resource,
      `Cloudflare DNS record "${record.name}" static content must not be empty.`,
    )

    const validContent =
      record.type === "A"
        ? isIP(content) === 4
        : record.type === "AAAA"
          ? isIP(content) === 6
          : record.type === "CNAME" || record.type === "MX"
            ? isDnsHostname(content)
            : true

    yield* requireResourceConfigEffect(
      validContent,
      resource,
      `Cloudflare ${record.type} record "${record.name}" has malformed static content.`,
    )
  })
}

export function validateCloudflareIngressRuleEffect(
  rule: CloudflareIngressRule,
): Effect.Effect<void, PulumiResourceConfigError> {
  return Effect.try({
    try: () => new URL(rule.service),
    catch: () =>
      new PulumiResourceConfigError({
        resource: `ingress:${rule.hostname}`,
        message: `Cloudflare ingress origin for "${rule.hostname}" must be an absolute HTTP(S) URL.`,
      }),
  }).pipe(
    Effect.flatMap((origin) => {
      if (origin.username || origin.password) {
        return Effect.fail(
          new PulumiResourceConfigError({
            resource: `ingress:${rule.hostname}`,
            message: `Cloudflare ingress origin for "${rule.hostname}" must not contain embedded credentials.`,
          }),
        )
      }

      const disablesTlsVerification =
        (rule.originRequest as { readonly noTlsVerify?: unknown } | undefined)?.noTlsVerify === true

      if (disablesTlsVerification) {
        return Effect.fail(
          new PulumiResourceConfigError({
            resource: `ingress:${rule.hostname}`,
            message: `Cloudflare ingress origin for "${rule.hostname}" cannot disable TLS verification.`,
          }),
        )
      }

      if (origin.protocol === "http:") {
        if (!isPrivateHttpOrigin(origin.hostname)) {
          return Effect.fail(
            new PulumiResourceConfigError({
              resource: `ingress:${rule.hostname}`,
              message: `Plain HTTP origin for "${rule.hostname}" must be loopback, RFC1918, ULA, or a private home.arpa host.`,
            }),
          )
        }

        return rule.insecureOriginReason && rule.insecureOriginReason.trim().length >= 20
          ? Effect.void
          : Effect.fail(
              new PulumiResourceConfigError({
                resource: `ingress:${rule.hostname}`,
                message: `Plain HTTP origin for "${rule.hostname}" requires a specific migration justification.`,
              }),
            )
      }

      if (origin.protocol !== "https:") {
        return Effect.fail(
          new PulumiResourceConfigError({
            resource: `ingress:${rule.hostname}`,
            message: `Cloudflare ingress origin for "${rule.hostname}" must use HTTP or HTTPS.`,
          }),
        )
      }

      if (
        isIP(origin.hostname.replace(/^\[|\]$/g, "")) !== 0 &&
        !rule.originRequest?.originServerName
      ) {
        return Effect.fail(
          new PulumiResourceConfigError({
            resource: `ingress:${rule.hostname}`,
            message: `HTTPS origin for "${rule.hostname}" uses an IP address and requires originServerName for certificate verification.`,
          }),
        )
      }

      return Effect.void
    }),
  )
}

/**
 * Validates and normalizes the complete static Cloudflare graph without
 * registering resources. Stack entrypoints can run this before constructing
 * dynamic Pulumi inputs such as StackReferences.
 */
export function planCloudflareEdgeEffect<DirectRecord extends CloudflareDnsRecordPlan>(
  args: CloudflareEdgePlanArgs<DirectRecord>,
): Effect.Effect<CloudflareEdgePlan<DirectRecord>, PulumiResourceConfigError> {
  return Effect.gen(function* () {
    yield* requireResourceConfigEffect(
      args.accountId.trim().length > 0,
      "cloudflare:account",
      "Cloudflare account id must not be empty.",
    )
    yield* requireResourceConfigEffect(
      args.tunnel.name.trim().length > 0,
      "cloudflare:tunnel",
      "Cloudflare tunnel name must not be empty.",
    )
    yield* requireResourceConfigEffect(
      args.tunnel.defaultService.trim().length > 0,
      "cloudflare:tunnel",
      "Cloudflare tunnel default service must not be empty.",
    )

    const configuredZoneNames = Object.keys(args.zones)
    const zoneIdNames = Object.keys(args.zoneIds)
    const zoneSecurityNames = Object.keys(args.zoneSecurity)

    yield* requireResourceConfigEffect(
      configuredZoneNames.length > 0,
      "cloudflare:zones",
      "At least one Cloudflare zone must be declared.",
    )
    yield* requireResourceConfigEffect(
      configuredZoneNames.every((zone) => args.zones[zone]?.trim()),
      "cloudflare:zones",
      "Cloudflare zone names must not be empty.",
    )
    yield* requireResourceConfigEffect(
      configuredZoneNames.every((zone) => args.zoneIds[zone]?.trim()),
      "cloudflare:zones",
      "Every Cloudflare zone must have a non-empty zone id.",
    )
    yield* requireResourceConfigEffect(
      zoneIdNames.every((zone) => Object.hasOwn(args.zones, zone)),
      "cloudflare:zones",
      "Cloudflare zone ids may only reference declared zones.",
    )
    yield* requireResourceConfigEffect(
      configuredZoneNames.every((zone) => Object.hasOwn(args.zoneSecurity, zone)) &&
        zoneSecurityNames.every((zone) => Object.hasOwn(args.zones, zone)),
      "cloudflare:zone-security",
      "Every declared Cloudflare zone must have exactly one explicit security policy.",
    )

    const zoneSecurityPolicies = yield* Effect.forEach(configuredZoneNames, (zone) =>
      Effect.gen(function* () {
        const policy = args.zoneSecurity[zone]!
        const maxAge = policy.strictTransportSecurity.maxAge

        yield* requireResourceConfigEffect(
          Number.isInteger(maxAge) && maxAge >= 0,
          `zone-security:${zone}`,
          `Cloudflare zone "${zone}" HSTS maxAge must be a non-negative integer.`,
        )

        return {
          zone,
          zoneId: args.zoneIds[zone]!,
          policy,
        } as const
      }),
    )

    const normalizedIngressHostnames = args.ingressRules.map((rule) =>
      rule.hostname.trim().toLowerCase(),
    )
    yield* requireResourceConfigEffect(
      normalizedIngressHostnames.every((hostname) => hostname.length > 0),
      "cloudflare:ingress",
      "Cloudflare ingress hostnames must not be empty.",
    )
    yield* validateUniqueValuesEffect(
      normalizedIngressHostnames,
      "cloudflare:ingress",
      "Cloudflare ingress hostnames",
    )

    const ingressRules = yield* Effect.forEach(args.ingressRules, (rule) =>
      Effect.gen(function* () {
        yield* validateCloudflareIngressRuleEffect(rule)
        const zoneId = yield* requireZoneEffect(args, rule.zone, `ingress:${rule.hostname}`)

        return {
          rule,
          zoneId,
          logicalName: logicalResourceName(rule.resourceName, rule.hostname),
        } as const
      }),
    )

    const directRecords = yield* Effect.forEach(args.dnsRecords ?? [], (record) =>
      Effect.gen(function* () {
        yield* validateCloudflareDnsRecordEffect(record)
        const zoneId = yield* requireZoneEffect(
          args,
          record.zone,
          `dns:${record.type}:${record.name}`,
        )

        return {
          record,
          zoneId,
          logicalName: logicalResourceName(record.resourceName, `${record.type}-${record.name}`),
        } as const
      }),
    )

    yield* validateUniqueValuesEffect(
      [
        ...ingressRules.map(({ rule }) => physicalDnsIdentity(rule.zone, "CNAME", rule.hostname)),
        ...directRecords.map(({ record }) =>
          physicalDnsIdentity(record.zone, record.type, record.name),
        ),
      ],
      "cloudflare:dns",
      "Cloudflare physical DNS identities (zone, type, name)",
    )

    const accessApplications = yield* Effect.forEach(args.accessApplications ?? [], (application) =>
      Effect.gen(function* () {
        yield* requireResourceConfigEffect(
          application.hostname.trim().length > 0,
          `access:${application.name}`,
          `Cloudflare Access application "${application.name}" hostname must not be empty.`,
        )
        yield* requireResourceConfigEffect(
          application.allowedEmails.length > 0,
          `access:${application.hostname}`,
          `Cloudflare Access application "${application.name}" needs at least one allowed email.`,
        )

        return {
          application,
          logicalName: logicalResourceName(
            application.resourceName,
            `access-${application.hostname}`,
          ),
        }
      }),
    )
    yield* validateUniqueValuesEffect(
      accessApplications.map(({ application }) => application.hostname.trim().toLowerCase()),
      "cloudflare:access",
      "Cloudflare Access application hostnames",
    )

    const r2Buckets = yield* Effect.forEach(args.r2Buckets ?? [], (bucket) =>
      requireResourceConfigEffect(
        bucket.name.trim().length > 0,
        "cloudflare:r2",
        "Cloudflare R2 bucket names must not be empty.",
      ).pipe(
        Effect.map(() => ({
          bucket,
          logicalName: logicalResourceName(bucket.resourceName, bucket.name),
        })),
      ),
    )
    yield* validateUniqueValuesEffect(
      r2Buckets.map(({ bucket }) => bucket.name.trim().toLowerCase()),
      "cloudflare:r2",
      "Cloudflare R2 bucket names",
    )
    const tunnelResourceName = args.resourceNames?.tunnel ?? resourceName(args.tunnel.name)
    const tunnelConfigResourceName =
      args.resourceNames?.tunnelConfig ?? `${tunnelResourceName}-config`
    const logicalNames = [
      tunnelResourceName,
      tunnelConfigResourceName,
      ...ingressRules.map(({ logicalName }) => logicalName),
      ...directRecords.map(({ logicalName }) => logicalName),
      ...r2Buckets.map(({ logicalName }) => logicalName),
      ...accessApplications.map(({ logicalName }) => logicalName),
      ...zoneSecurityPolicies.flatMap(({ zone, policy }) =>
        Object.values(cloudflareZoneSecuritySettings(policy)).map((setting) =>
          resourceName(`${zone}-${setting.settingId}`),
        ),
      ),
    ]

    yield* requireResourceConfigEffect(
      logicalNames.every((name) => name.trim().length > 0),
      "cloudflare:resource-names",
      "Cloudflare Pulumi logical resource names must not be empty.",
    )
    yield* validateUniqueValuesEffect(
      logicalNames,
      "cloudflare:resource-names",
      "Cloudflare Pulumi logical resource names",
    )

    return {
      tunnelResourceName,
      tunnelConfigResourceName,
      ingressRules,
      directRecords,
      zoneSecurityPolicies,
      r2Buckets,
      accessApplications,
    }
  }).pipe(Effect.withSpan("Cloudflare.planEdge"))
}

export const createCloudflareEdgeEffect = Effect.fn("Cloudflare.createEdge")(function* (
  args: CloudflareEdgeArgs,
) {
  const plan = yield* planCloudflareEdgeEffect(args)
  const {
    accessApplications: accessApplicationSpecs,
    directRecords,
    ingressRules,
    r2Buckets: r2BucketSpecs,
    tunnelConfigResourceName,
    tunnelResourceName,
    zoneSecurityPolicies,
  } = plan

  const tunnel = yield* registerPulumiResource(
    tunnelResourceName,
    () =>
      new cloudflare.ZeroTrustTunnelCloudflared(
        tunnelResourceName,
        {
          accountId: args.accountId,
          name: args.tunnel.name,
          configSrc: "cloudflare",
          tunnelSecret: args.tunnelSecret,
        },
        args.resourceOptions,
      ),
  )

  const tunnelCname = pulumi.interpolate`${tunnel.id}.cfargotunnel.com`

  const tunnelConfig = yield* registerPulumiResource(
    tunnelConfigResourceName,
    () =>
      new cloudflare.ZeroTrustTunnelCloudflaredConfig(
        tunnelConfigResourceName,
        {
          accountId: args.accountId,
          tunnelId: tunnel.id,
          source: "cloudflare",
          config: {
            ingresses: [
              ...ingressRules.map(({ rule }) => ({
                hostname: rule.hostname,
                service: rule.service,
                ...(rule.originRequest
                  ? {
                      originRequest: rule.originRequest,
                    }
                  : undefined),
              })),
              {
                service: args.tunnel.defaultService,
              },
            ],
          },
        },
        args.resourceOptions,
      ),
  )

  const dnsRecords = Object.fromEntries(
    yield* Effect.forEach(ingressRules, ({ logicalName, rule, zoneId }) => {
      return registerPulumiResource(
        logicalName,
        () =>
          new cloudflare.DnsRecord(
            logicalName,
            {
              zoneId,
              name: rule.hostname,
              type: "CNAME",
              content: tunnelCname,
              proxied: true,
              ttl: 1,
            },
            args.resourceOptions,
          ),
      ).pipe(Effect.map((record) => [rule.hostname, record] as const))
    }),
  )

  const directDnsRecords = Object.fromEntries(
    yield* Effect.forEach(directRecords, ({ logicalName, record, zoneId }) => {
      return registerPulumiResource(
        logicalName,
        () =>
          new cloudflare.DnsRecord(
            logicalName,
            {
              zoneId,
              name: record.name,
              type: record.type,
              content: record.content,
              ttl: record.ttl ?? 1,
              ...(record.priority != null ? { priority: record.priority } : {}),
              ...(record.proxied != null ? { proxied: record.proxied } : {}),
            },
            args.resourceOptions,
          ),
      ).pipe(Effect.map((dnsRecord) => [`${record.type}:${record.name}`, dnsRecord] as const))
    }),
  )

  const zoneSecurity = Object.fromEntries(
    yield* Effect.forEach(zoneSecurityPolicies, ({ policy, zone, zoneId }) =>
      Effect.gen(function* () {
        const settings = Object.fromEntries(
          yield* Effect.forEach(
            Object.entries(cloudflareZoneSecuritySettings(policy)),
            ([name, setting]) => {
              const logicalName = resourceName(`${zone}-${setting.settingId}`)
              return registerPulumiResource(
                logicalName,
                () =>
                  new cloudflare.ZoneSetting(
                    logicalName,
                    {
                      zoneId,
                      settingId: setting.settingId,
                      value: setting.value,
                    },
                    args.resourceOptions,
                  ),
              ).pipe(Effect.map((zoneSetting) => [name, zoneSetting.value] as const))
            },
          ),
        )

        return [zone, settings] as const
      }),
    ),
  )

  const r2Buckets = Object.fromEntries(
    yield* Effect.forEach(r2BucketSpecs, ({ bucket, logicalName }) => {
      return registerPulumiResource(
        logicalName,
        () =>
          new cloudflare.R2Bucket(
            logicalName,
            {
              accountId: args.accountId,
              name: bucket.name,
              ...(bucket.location ? { location: bucket.location } : {}),
              ...(bucket.jurisdiction ? { jurisdiction: bucket.jurisdiction } : {}),
              ...(bucket.storageClass ? { storageClass: bucket.storageClass } : {}),
            },
            args.resourceOptions,
          ),
      ).pipe(
        Effect.map(
          (r2Bucket) =>
            [
              bucket.name,
              {
                name: r2Bucket.name,
                location: r2Bucket.location,
                jurisdiction: r2Bucket.jurisdiction,
                storageClass: r2Bucket.storageClass,
              },
            ] as const,
        ),
      )
    }),
  )

  const accessApplications = Object.fromEntries(
    yield* Effect.forEach(accessApplicationSpecs, ({ application, logicalName }) => {
      const sessionDuration = application.sessionDuration ?? "8h"

      return registerPulumiResource(
        logicalName,
        () =>
          new cloudflare.ZeroTrustAccessApplication(
            logicalName,
            {
              accountId: args.accountId,
              name: application.name,
              domain: application.hostname,
              type: "self_hosted",
              appLauncherVisible: false,
              enableBindingCookie: true,
              httpOnlyCookieAttribute: true,
              sameSiteCookieAttribute: "strict",
              sessionDuration,
              policies: [
                {
                  name: `${application.name} admins`,
                  decision: "allow",
                  includes: application.allowedEmails.map((email) => ({
                    email: {
                      email,
                    },
                  })),
                  precedence: 1,
                },
              ],
            },
            args.resourceOptions,
          ),
      ).pipe(
        Effect.map(
          (accessApplication) =>
            [
              application.hostname,
              {
                aud: accessApplication.aud,
                domain: accessApplication.domain,
                name: accessApplication.name,
              },
            ] as const,
        ),
      )
    }),
  )

  const tunnelTokenOutput = yield* registerPulumiResource(`${tunnelResourceName}-token`, () =>
    cloudflare.getZeroTrustTunnelCloudflaredTokenOutput({
      accountId: args.accountId,
      tunnelId: tunnel.id,
    }),
  )
  const tunnelToken = pulumi.secret(tunnelTokenOutput.token)

  return {
    accountId: args.accountId,
    dnsZones: args.zones,
    hostnames: [
      ...Object.keys(dnsRecords),
      ...(args.dnsRecords ?? []).map((record) => record.name),
    ],
    directDnsRecords,
    zoneSecurity,
    r2Buckets,
    accessApplications,
    tunnelCname,
    tunnelId: tunnel.id,
    tunnelName: tunnel.name,
    tunnelToken,
    configVersion: tunnelConfig.version,
  }
})
