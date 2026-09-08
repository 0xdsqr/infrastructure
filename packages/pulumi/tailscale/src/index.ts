import {
  PulumiResourceConfigError,
  registerPulumiResource,
  requireResourceConfigEffect,
} from "@dsqr/pulumi-shared"
import * as pulumi from "@pulumi/pulumi"
import * as tailscale from "@pulumi/tailscale"
import { Effect } from "effect"

export type TailscaleKeySpec = {
  readonly resourceName: string
  readonly description: string
  readonly tags: ReadonlyArray<string>
  readonly lifecycle?: TailscaleKeyLifecycle | undefined
}

export type TailscaleKeyLifecycle = "one-time" | "server-bootstrap"

export type TailscaleKeySpecs = Readonly<Record<string, TailscaleKeySpec>>

export type TailscaleDeviceTagSpec = {
  readonly resourceName: string
  readonly deviceId: string
  readonly tags: ReadonlyArray<string>
}

export type TailscaleDeviceTagSpecs = Readonly<Record<string, TailscaleDeviceTagSpec>>

export type JsonPrimitive = boolean | null | number | string
export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

type TailscaleResourceOptions = Omit<pulumi.CustomResourceOptions, "dependsOn">

export type TailscalePlatformArgs<KeySpecs extends TailscaleKeySpecs> = {
  readonly policyResourceName: string
  readonly policyDocument: JsonObject
  readonly keySpecs: KeySpecs
  readonly deviceTagSpecs?: TailscaleDeviceTagSpecs | undefined
  readonly resourceOptions?: TailscaleResourceOptions | undefined
}

export type TailscalePlatform<KeySpecs extends TailscaleKeySpecs> = {
  readonly policy: pulumi.Output<string>
  readonly deviceTags: Readonly<Record<string, pulumi.Output<string[]>>>
  readonly authKeys: {
    readonly [Key in keyof KeySpecs]: pulumi.Output<string>
  }
}

export const hardenedTailnetKeyDefaults = {
  reusable: false,
  ephemeral: false,
  preauthorized: false,
  expiry: 60 * 60,
  recreateIfInvalid: "never",
} as const

export const serverBootstrapTailnetKeyDefaults = {
  reusable: true,
  ephemeral: false,
  preauthorized: true,
  expiry: 90 * 24 * 60 * 60,
  recreateIfInvalid: "always",
} as const

export const tailnetPolicySafetyDefaults = {
  overwriteExistingContent: false,
  resetAclOnDestroy: false,
} as const

const createTailnetKeyEffect = (
  spec: TailscaleKeySpec,
  policy: tailscale.Acl,
  resourceOptions: TailscaleResourceOptions | undefined,
) =>
  registerPulumiResource(
    spec.resourceName,
    () =>
      new tailscale.TailnetKey(
        spec.resourceName,
        {
          description: spec.description,
          ...(spec.lifecycle === "server-bootstrap"
            ? serverBootstrapTailnetKeyDefaults
            : hardenedTailnetKeyDefaults),
          tags: [...spec.tags],
        },
        {
          ...resourceOptions,
          dependsOn: [policy],
        },
      ),
  )

const tailnetTagPattern = /^tag:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

function invalidJsonPath(
  value: unknown,
  path: string,
  ancestors: ReadonlySet<object>,
): string | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return undefined
  }

  if (typeof value !== "object") {
    return path
  }

  if (ancestors.has(value)) {
    return path
  }

  const nextAncestors = new Set(ancestors).add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        return `${path}[${index}]`
      }
      const invalid = invalidJsonPath(value[index], `${path}[${index}]`, nextAncestors)
      if (invalid) {
        return invalid
      }
    }
    return undefined
  }

  const prototype = Object.getPrototypeOf(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    return path
  }

  for (const [key, child] of Object.entries(value)) {
    const invalid = invalidJsonPath(child, `${path}.${JSON.stringify(key)}`, nextAncestors)
    if (invalid) {
      return invalid
    }
  }

  return undefined
}

const serializePolicyDocument = Effect.fn("Tailscale.serializePolicyDocument")(function* (
  policyDocument: unknown,
) {
  yield* requireResourceConfigEffect(
    typeof policyDocument === "object" && policyDocument !== null && !Array.isArray(policyDocument),
    "tailscale:policyDocument",
    "Tailnet policy must be a JSON object.",
  )

  const invalidPath = invalidJsonPath(policyDocument, "$", new Set())
  yield* requireResourceConfigEffect(
    invalidPath === undefined,
    "tailscale:policyDocument",
    `Tailnet policy must be JSON serializable without lossy values; invalid value at ${invalidPath}.`,
  )

  const serialized = yield* Effect.try({
    try: () => JSON.stringify(policyDocument, null, 2),
    catch: (cause) =>
      new PulumiResourceConfigError({
        resource: "tailscale:policyDocument",
        message: `Tailnet policy must be JSON serializable: ${String(cause)}`,
      }),
  })

  const serializedDocument = yield* requireResourceConfigEffect(
    typeof serialized === "string",
    "tailscale:policyDocument",
    "Tailnet policy must serialize to a JSON object.",
  ).pipe(Effect.as(serialized as string))

  const parsed = yield* Effect.try({
    try: () => JSON.parse(serializedDocument) as unknown,
    catch: (cause) =>
      new PulumiResourceConfigError({
        resource: "tailscale:policyDocument",
        message: `Serialized tailnet policy is not valid JSON: ${String(cause)}`,
      }),
  })

  yield* requireResourceConfigEffect(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    "tailscale:policyDocument",
    "Tailnet policy must serialize to a JSON object.",
  )

  return serializedDocument
})

export const validateTailscalePlatformArgs = Effect.fn("Tailscale.validatePlatformArgs")(function* <
  KeySpecs extends TailscaleKeySpecs,
>(args: TailscalePlatformArgs<KeySpecs>) {
  yield* requireResourceConfigEffect(
    args.policyResourceName.trim().length > 0,
    "tailscale:policy",
    "Policy resourceName must not be empty.",
  )

  const resourceNames = new Set<string>([args.policyResourceName])

  for (const [key, spec] of Object.entries(args.keySpecs)) {
    yield* requireResourceConfigEffect(
      spec.resourceName.trim().length > 0,
      `tailscale:key:${key}`,
      "Tailnet key resourceName must not be empty.",
    )
    yield* requireResourceConfigEffect(
      !resourceNames.has(spec.resourceName),
      `tailscale:key:${key}`,
      `Tailnet key resourceName "${spec.resourceName}" must be unique.`,
    )
    resourceNames.add(spec.resourceName)

    yield* requireResourceConfigEffect(
      spec.description.trim().length > 0,
      `tailscale:key:${key}`,
      "Tailnet key description must not be empty.",
    )
    yield* requireResourceConfigEffect(
      Array.from(spec.description).length <= 50,
      `tailscale:key:${key}`,
      "Tailnet key description must contain at most 50 characters.",
    )
    yield* requireResourceConfigEffect(
      spec.tags.length > 0,
      `tailscale:key:${key}`,
      "Tailnet key must assign at least one tag.",
    )
    yield* requireResourceConfigEffect(
      spec.tags.every((tag) => tailnetTagPattern.test(tag)),
      `tailscale:key:${key}`,
      'Tailnet key tags must use "tag:<name>" syntax.',
    )
    yield* requireResourceConfigEffect(
      new Set(spec.tags).size === spec.tags.length,
      `tailscale:key:${key}`,
      "Tailnet key tags must be unique.",
    )
  }

  const deviceIds = new Set<string>()
  for (const [key, spec] of Object.entries(args.deviceTagSpecs ?? {})) {
    const resource = `tailscale:deviceTags:${key}`
    yield* requireResourceConfigEffect(
      spec.resourceName.trim().length > 0 && !resourceNames.has(spec.resourceName),
      resource,
      "Device tag resourceName must be non-empty and unique.",
    )
    resourceNames.add(spec.resourceName)
    yield* requireResourceConfigEffect(
      spec.deviceId.trim().length > 0 && !deviceIds.has(spec.deviceId),
      resource,
      "Device ID must be non-empty and managed only once.",
    )
    deviceIds.add(spec.deviceId)
    yield* requireResourceConfigEffect(
      spec.tags.length > 0 &&
        spec.tags.every((tag) => tailnetTagPattern.test(tag)) &&
        new Set(spec.tags).size === spec.tags.length,
      resource,
      "Device tags must be a non-empty, unique list using tag:<name> syntax.",
    )
  }

  return yield* serializePolicyDocument(args.policyDocument)
})

export const createTailscalePlatformEffect = Effect.fn("Tailscale.createPlatform")(function* <
  const KeySpecs extends TailscaleKeySpecs,
>(args: TailscalePlatformArgs<KeySpecs>) {
  const policyDocument = yield* validateTailscalePlatformArgs(args)

  const policy = yield* registerPulumiResource(
    args.policyResourceName,
    () =>
      new tailscale.Acl(
        args.policyResourceName,
        {
          acl: policyDocument,
          ...tailnetPolicySafetyDefaults,
        },
        args.resourceOptions,
      ),
  )

  const authKeys = {} as {
    [Key in keyof KeySpecs]: pulumi.Output<string>
  }

  for (const [key, spec] of Object.entries(args.keySpecs)) {
    const tailnetKey = yield* createTailnetKeyEffect(spec, policy, args.resourceOptions)
    authKeys[key as keyof KeySpecs] = pulumi.secret(tailnetKey.key)
  }

  const deviceTags: Record<string, pulumi.Output<string[]>> = {}
  for (const [key, spec] of Object.entries(args.deviceTagSpecs ?? {})) {
    const device = yield* registerPulumiResource(
      spec.resourceName,
      () =>
        new tailscale.DeviceTags(
          spec.resourceName,
          { deviceId: spec.deviceId, tags: [...spec.tags] },
          {
            ...args.resourceOptions,
            dependsOn: [policy],
            // Removing inventory must not silently remove a machine's identity.
            protect: true,
            retainOnDelete: true,
          },
        ),
    )
    deviceTags[key] = device.tags
  }

  return {
    policy: policy.acl,
    deviceTags,
    authKeys,
  } satisfies TailscalePlatform<KeySpecs>
})
