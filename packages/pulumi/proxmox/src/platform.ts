import { resolveVmSpec, type ResolvedVmSpec, type VmDefaults, type VmInventory } from "@dsqr/model"
import type * as pulumi from "@pulumi/pulumi"
import { Effect } from "effect"

import { PulumiResourceConfigError, requireResourceConfigEffect } from "@dsqr/pulumi-shared"

import type { ProxmoxConnectionConfig } from "./config.ts"
import { createProxmoxProviderEffect } from "./provider.ts"
import { createResolvedProxmoxVmEffect, describeVm, type ProxmoxVmTransforms } from "./vm.ts"

export type ProxmoxPlatformArgs = {
  connection: ProxmoxConnectionConfig
  defaults: VmDefaults
  inventory: VmInventory
  providerName?: string
  providerOptions?: pulumi.ResourceOptions
  transform?: ProxmoxVmTransforms
}

export type ProxmoxPlatformVmPlan = {
  readonly key: string
  readonly spec: ResolvedVmSpec
}

export type ProxmoxPlatformPlan = {
  readonly providerName: string
  readonly vms: ReadonlyArray<ProxmoxPlatformVmPlan>
}

const duplicateValues = <Value>(
  values: ReadonlyArray<Value>,
  normalize: (value: Value) => string,
) => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()

  for (const value of values) {
    const normalized = normalize(value)
    if (seen.has(normalized)) {
      duplicates.add(normalized)
    } else {
      seen.add(normalized)
    }
  }

  return [...duplicates].sort()
}

const requireUnique = (
  resource: string,
  label: string,
  values: ReadonlyArray<string | number>,
  normalize: (value: string | number) => string = String,
) => {
  const duplicates = duplicateValues(values, normalize)

  return requireResourceConfigEffect(
    duplicates.length === 0,
    resource,
    `${label} must be unique; duplicated: ${duplicates.join(", ")}.`,
  )
}

export const planProxmoxPlatform = Effect.fn("Proxmox.planPlatform")(function* (
  args: ProxmoxPlatformArgs,
) {
  const providerName = args.providerName ?? "proxmoxve"
  const vms = Object.entries(args.inventory).map(([key, spec]) => ({
    key,
    spec: resolveVmSpec(spec, args.defaults),
  }))

  if (providerName.trim().length === 0) {
    return yield* new PulumiResourceConfigError({
      resource: "proxmox:provider",
      message: "Pulumi provider logical name must be non-empty.",
    })
  }

  yield* requireUnique(
    "proxmox:vms",
    "Pulumi VM logical resource names",
    vms.map(({ spec }) => spec.resourceName),
  )
  yield* requireUnique(
    "proxmox:vms",
    "Proxmox VM IDs",
    vms.map(({ spec }) => spec.vmId),
  )
  yield* requireUnique(
    "proxmox:vms",
    "Proxmox VM names",
    vms.map(({ spec }) => spec.name),
  )
  yield* requireUnique(
    "proxmox:vms",
    "Explicit Proxmox VM MAC addresses",
    vms.flatMap(({ spec }) => (spec.macAddress === undefined ? [] : [spec.macAddress])),
    (value) => String(value).trim().toLowerCase(),
  )

  return {
    providerName,
    vms,
  } satisfies ProxmoxPlatformPlan
})

export const createProxmoxPlatformEffect = Effect.fn("Proxmox.createPlatform")(function* (
  args: ProxmoxPlatformArgs,
) {
  const plan = yield* planProxmoxPlatform(args)
  const provider = yield* createProxmoxProviderEffect(
    plan.providerName,
    args.connection,
    args.providerOptions,
  )
  const vmEntries = yield* Effect.forEach(
    plan.vms,
    ({ key, spec }) =>
      Effect.gen(function* () {
        const vm = yield* createResolvedProxmoxVmEffect({
          spec,
          provider,
          ...(args.transform ? { transform: args.transform } : {}),
        })
        return [key, describeVm(vm)] as const
      }),
    { concurrency: 1 },
  )

  return {
    provider: {
      endpoint: args.connection.endpoint,
      insecure: args.connection.insecure,
    },
    vms: Object.fromEntries(vmEntries),
  }
})
