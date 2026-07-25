import * as path from "node:path"
import { isIP } from "node:net"

import * as k8s from "@pulumi/kubernetes"
import * as pulumi from "@pulumi/pulumi"
import { Effect } from "effect"

import {
  PulumiResourceConfigError,
  registerPulumiResource,
  requireResourceConfigEffect,
} from "@dsqr/pulumi-shared"

export type NamespaceInventoryLike = Readonly<
  Record<
    string,
    {
      readonly resourceName?: string | undefined
      readonly name: string
      readonly labels?: Readonly<Record<string, string>> | undefined
      readonly annotations?: Readonly<Record<string, string>> | undefined
    }
  >
>

export type HelmReleaseInventoryLike = Readonly<
  Record<
    string,
    {
      readonly resourceName?: string | undefined
      readonly releaseName: string
      readonly namespace: string
      readonly chart: string
      readonly enabled?: boolean | undefined
      readonly repository?: string | undefined
      readonly version?: string | undefined
      readonly values?: Readonly<Record<string, unknown>> | undefined
      readonly valueYamlFiles?: ReadonlyArray<string> | undefined
      readonly dependsOn?: ReadonlyArray<string> | undefined
    }
  >
>

export type MetalLbAddressPoolInventoryLike = Readonly<
  Record<
    string,
    {
      readonly resourceName?: string | undefined
      readonly name: string
      readonly namespace: string
      readonly addresses: ReadonlyArray<string>
      readonly autoAssign?: boolean | undefined
      readonly avoidBuggyIPs?: boolean | undefined
    }
  >
>

export type MetalLbL2AdvertisementInventoryLike = Readonly<
  Record<
    string,
    {
      readonly resourceName?: string | undefined
      readonly name: string
      readonly namespace: string
      readonly ipAddressPools: ReadonlyArray<string>
    }
  >
>

type KubernetesResourceOptions = Omit<pulumi.CustomResourceOptions, "dependsOn">

export type KubernetesPlatformArgs = {
  readonly stackRoot: string
  readonly namespaces: NamespaceInventoryLike
  readonly helmReleases: HelmReleaseInventoryLike
  readonly metallbAddressPools: MetalLbAddressPoolInventoryLike
  readonly metallbL2Advertisements: MetalLbL2AdvertisementInventoryLike
  readonly metallbReleaseKey?: string
  readonly resourceOptions?: KubernetesResourceOptions
}

export type KubernetesPlatformPlan = {
  readonly releaseOrder: ReadonlyArray<string>
  readonly advertisementPoolKeys: Readonly<Record<string, ReadonlyArray<string>>>
  readonly metallbReleaseKey: string
}

const configError = (resource: string, message: string) =>
  new PulumiResourceConfigError({ resource, message })

const namespaceMetadata = (spec: NamespaceInventoryLike[string]) => ({
  name: spec.name,
  ...(spec.labels ? { labels: spec.labels } : undefined),
  ...(spec.annotations ? { annotations: spec.annotations } : undefined),
})

const resolveChartReference = (stackRoot: string, spec: HelmReleaseInventoryLike[string]) =>
  spec.repository ? spec.chart : path.resolve(stackRoot, spec.chart)

const resolveValueYamlFiles = (stackRoot: string, valueYamlFiles: ReadonlyArray<string>) =>
  valueYamlFiles.map((valuePath) => new pulumi.asset.FileAsset(path.resolve(stackRoot, valuePath)))

const resourceOptions = (
  base: KubernetesResourceOptions | undefined,
  dependsOn: ReadonlyArray<pulumi.Input<pulumi.Resource>>,
): pulumi.CustomResourceOptions | undefined => {
  if (!base && dependsOn.length === 0) {
    return undefined
  }

  return {
    ...base,
    ...(dependsOn.length > 0 ? { dependsOn: [...dependsOn] } : undefined),
  }
}

const requireUniqueLogicalNames = (resource: string, names: ReadonlyArray<string>) =>
  requireResourceConfigEffect(
    names.every((name) => name.trim().length > 0) && new Set(names).size === names.length,
    resource,
    "Pulumi logical resource names must be non-empty and unique.",
  )

const isValidAddressSelector = (value: string) => {
  if (value.trim() !== value || value.length === 0) {
    return false
  }

  if (value.includes("/")) {
    const [address, prefix, extra] = value.split("/")
    if (!address || !prefix || extra !== undefined || !/^\d+$/.test(prefix)) {
      return false
    }
    const family = isIP(address)
    const bits = Number(prefix)
    return (family === 4 && bits >= 0 && bits <= 32) || (family === 6 && bits >= 0 && bits <= 128)
  }

  if (value.includes("-")) {
    const [start, end, extra] = value.split("-")
    return (
      extra === undefined &&
      start !== undefined &&
      end !== undefined &&
      isIP(start) !== 0 &&
      isIP(start) === isIP(end)
    )
  }

  return isIP(value) !== 0
}

export const planKubernetesPlatform = Effect.fn("Kubernetes.planPlatform")(function* (
  args: KubernetesPlatformArgs,
) {
  const releaseEntries = Object.entries(args.helmReleases)
  const enabledReleaseEntries = releaseEntries.filter(([, spec]) => spec.enabled !== false)
  const enabledReleaseKeys = enabledReleaseEntries.map(([key]) => key)
  const enabledReleaseSet = new Set(enabledReleaseKeys)
  const releaseOrderIndex = new Map(enabledReleaseKeys.map((key, index) => [key, index]))
  const indegree = new Map(enabledReleaseKeys.map((key) => [key, 0]))
  const dependents = new Map(enabledReleaseKeys.map((key) => [key, [] as string[]]))

  yield* requireResourceConfigEffect(
    args.stackRoot.trim().length > 0,
    "kubernetes:stackRoot",
    "stackRoot must not be empty.",
  )
  yield* requireUniqueLogicalNames(
    "kubernetes:namespaces",
    Object.entries(args.namespaces).map(([key, spec]) => spec.resourceName ?? key),
  )
  yield* requireUniqueLogicalNames(
    "kubernetes:helm",
    enabledReleaseEntries.map(([key, spec]) => spec.resourceName ?? key),
  )
  yield* requireResourceConfigEffect(
    Object.values(args.namespaces).every((spec) => spec.name.trim().length > 0) &&
      new Set(Object.values(args.namespaces).map((spec) => spec.name)).size ===
        Object.keys(args.namespaces).length,
    "kubernetes:namespaces",
    "Namespace metadata names must be non-empty and unique.",
  )
  const releaseIdentities = enabledReleaseEntries.map(
    ([, spec]) => `${spec.namespace}\0${spec.releaseName}`,
  )
  yield* requireResourceConfigEffect(
    enabledReleaseEntries.every(
      ([, spec]) =>
        spec.releaseName.trim().length > 0 &&
        spec.namespace.trim().length > 0 &&
        spec.chart.trim().length > 0 &&
        (!spec.repository || spec.repository.trim().length > 0) &&
        (!spec.version || spec.version.trim().length > 0) &&
        new Set(spec.dependsOn ?? []).size === (spec.dependsOn ?? []).length,
    ) && new Set(releaseIdentities).size === releaseIdentities.length,
    "kubernetes:helm",
    "Enabled Helm releases require non-empty fields, unique dependencies, and unique namespace/name identities.",
  )
  yield* requireUniqueLogicalNames(
    "kubernetes:metallb-address-pools",
    Object.entries(args.metallbAddressPools).map(
      ([key, spec]) => spec.resourceName ?? `metallb-ipaddresspool-${key}`,
    ),
  )
  yield* requireUniqueLogicalNames(
    "kubernetes:metallb-l2-advertisements",
    Object.entries(args.metallbL2Advertisements).map(
      ([key, spec]) => spec.resourceName ?? `metallb-l2advertisement-${key}`,
    ),
  )

  for (const [releaseKey, spec] of enabledReleaseEntries) {
    for (const dependencyKey of spec.dependsOn ?? []) {
      const dependency = args.helmReleases[dependencyKey]
      if (!dependency) {
        return yield* configError(
          `helm:${releaseKey}`,
          `Helm release ${releaseKey} depends on unknown release ${dependencyKey}.`,
        )
      }
      if (!enabledReleaseSet.has(dependencyKey)) {
        return yield* configError(
          `helm:${releaseKey}`,
          `Helm release ${releaseKey} depends on disabled release ${dependencyKey}.`,
        )
      }

      indegree.set(releaseKey, (indegree.get(releaseKey) ?? 0) + 1)
      dependents.get(dependencyKey)!.push(releaseKey)
    }
  }

  const ready = enabledReleaseKeys.filter((key) => indegree.get(key) === 0)
  const releaseOrder: string[] = []
  while (ready.length > 0) {
    const releaseKey = ready.shift()!
    releaseOrder.push(releaseKey)

    for (const dependent of dependents.get(releaseKey) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        ready.push(dependent)
        ready.sort((left, right) => releaseOrderIndex.get(left)! - releaseOrderIndex.get(right)!)
      }
    }
  }

  if (releaseOrder.length !== enabledReleaseKeys.length) {
    const cycle = enabledReleaseKeys.filter((key) => !releaseOrder.includes(key))
    return yield* configError(
      "kubernetes:helm",
      `Helm release dependency graph contains a cycle involving: ${cycle.join(", ")}.`,
    )
  }

  const metallbReleaseKey = args.metallbReleaseKey ?? "metallb"
  const hasMetalLbCustomResources =
    Object.keys(args.metallbAddressPools).length > 0 ||
    Object.keys(args.metallbL2Advertisements).length > 0

  yield* requireResourceConfigEffect(
    !hasMetalLbCustomResources || enabledReleaseSet.has(metallbReleaseKey),
    "metallb",
    `Enabled MetalLB release "${metallbReleaseKey}" is required when Pulumi owns MetalLB config.`,
  )

  const poolKeyByIdentity = new Map<string, string>()
  const poolIdentities = new Set<string>()
  for (const [key, spec] of Object.entries(args.metallbAddressPools)) {
    const identity = `${spec.namespace}\0${spec.name}`
    if (
      !spec.name.trim() ||
      !spec.namespace.trim() ||
      spec.addresses.length === 0 ||
      new Set(spec.addresses).size !== spec.addresses.length ||
      !spec.addresses.every(isValidAddressSelector) ||
      poolIdentities.has(identity)
    ) {
      return yield* configError(
        `metallb-ipaddresspool:${key}`,
        `MetalLB pool "${key}" must have a unique identity and non-empty valid addresses.`,
      )
    }
    poolKeyByIdentity.set(identity, key)
    poolIdentities.add(identity)
  }

  const advertisementPoolKeys: Record<string, ReadonlyArray<string>> = {}
  const advertisementIdentities = new Set<string>()
  for (const [key, spec] of Object.entries(args.metallbL2Advertisements)) {
    const identity = `${spec.namespace}\0${spec.name}`
    if (
      !spec.name.trim() ||
      !spec.namespace.trim() ||
      spec.ipAddressPools.length === 0 ||
      new Set(spec.ipAddressPools).size !== spec.ipAddressPools.length ||
      advertisementIdentities.has(identity)
    ) {
      return yield* configError(
        `metallb-l2advertisement:${key}`,
        `MetalLB advertisement "${key}" must have a unique identity and at least one unique pool.`,
      )
    }
    advertisementIdentities.add(identity)
    const poolKeys: string[] = []
    for (const poolName of spec.ipAddressPools) {
      const poolKey = poolKeyByIdentity.get(`${spec.namespace}\0${poolName}`)
      if (!poolKey) {
        return yield* configError(
          `metallb-l2advertisement:${key}`,
          `MetalLB advertisement ${key} references unknown pool "${poolName}".`,
        )
      }
      poolKeys.push(poolKey)
    }
    advertisementPoolKeys[key] = poolKeys
  }

  return {
    releaseOrder,
    advertisementPoolKeys,
    metallbReleaseKey,
  } satisfies KubernetesPlatformPlan
})

export const createKubernetesPlatformEffect = Effect.fn("Kubernetes.createPlatform")(function* (
  args: KubernetesPlatformArgs,
) {
  // Validate and order the entire graph before registering the first Pulumi resource.
  const plan = yield* planKubernetesPlatform(args)
  const namespaceEntries = Object.entries(args.namespaces)
  const namespaceResources = Object.fromEntries(
    yield* Effect.forEach(namespaceEntries, ([key, spec]) => {
      const name = spec.resourceName ?? key
      return registerPulumiResource(
        name,
        () =>
          new k8s.core.v1.Namespace(
            name,
            { metadata: namespaceMetadata(spec) },
            args.resourceOptions,
          ),
      ).pipe(Effect.map((namespace) => [key, namespace] as const))
    }),
  )
  const kubernetesNamespaces = Object.fromEntries(
    Object.entries(namespaceResources).map(([key, resource]) => [key, resource.metadata.name]),
  )
  const namespaceResourcesByName = Object.fromEntries(
    namespaceEntries.map(([key, spec]) => [spec.name, namespaceResources[key]]),
  )
  const releases: Record<string, k8s.helm.v3.Release> = {}

  for (const key of plan.releaseOrder) {
    const spec = args.helmReleases[key]!
    const releaseDependsOn: pulumi.Input<pulumi.Resource>[] = []
    const namespaceResource = namespaceResourcesByName[spec.namespace]
    if (namespaceResource) {
      releaseDependsOn.push(namespaceResource)
    }
    for (const dependencyKey of spec.dependsOn ?? []) {
      releaseDependsOn.push(releases[dependencyKey]!)
    }

    const releaseArgs: k8s.helm.v3.ReleaseArgs = {
      name: spec.releaseName,
      namespace: spec.namespace,
      chart: resolveChartReference(args.stackRoot, spec),
      createNamespace: false,
      skipAwait: false,
      atomic: true,
      cleanupOnFail: true,
      ...(spec.repository ? { repositoryOpts: { repo: spec.repository } } : undefined),
      ...(spec.version ? { version: spec.version } : undefined),
      ...(spec.values ? { values: spec.values } : undefined),
      ...(spec.valueYamlFiles
        ? { valueYamlFiles: resolveValueYamlFiles(args.stackRoot, spec.valueYamlFiles) }
        : undefined),
    }

    const name = spec.resourceName ?? key
    releases[key] = yield* registerPulumiResource(
      name,
      () =>
        new k8s.helm.v3.Release(
          name,
          releaseArgs,
          resourceOptions(args.resourceOptions, releaseDependsOn),
        ),
    )
  }

  const metallbRelease = releases[plan.metallbReleaseKey]
  const metallbPools = Object.fromEntries(
    yield* Effect.forEach(Object.entries(args.metallbAddressPools), ([key, spec]) => {
      const name = spec.resourceName ?? `metallb-ipaddresspool-${key}`
      return registerPulumiResource(
        name,
        () =>
          new k8s.apiextensions.CustomResource(
            name,
            {
              apiVersion: "metallb.io/v1beta1",
              kind: "IPAddressPool",
              metadata: {
                name: spec.name,
                namespace: spec.namespace,
              },
              spec: {
                addresses: spec.addresses,
                autoAssign: spec.autoAssign,
                avoidBuggyIPs: spec.avoidBuggyIPs,
              },
            },
            resourceOptions(args.resourceOptions, metallbRelease ? [metallbRelease] : []),
          ),
      ).pipe(Effect.map((pool) => [key, pool] as const))
    }),
  )
  const metallbAdvertisements = Object.fromEntries(
    yield* Effect.forEach(Object.entries(args.metallbL2Advertisements), ([key, spec]) => {
      const poolDependencies = plan.advertisementPoolKeys[key]!.map(
        (poolKey) => metallbPools[poolKey]!,
      )
      const dependencies = metallbRelease ? [metallbRelease, ...poolDependencies] : poolDependencies

      const name = spec.resourceName ?? `metallb-l2advertisement-${key}`
      return registerPulumiResource(
        name,
        () =>
          new k8s.apiextensions.CustomResource(
            name,
            {
              apiVersion: "metallb.io/v1beta1",
              kind: "L2Advertisement",
              metadata: {
                name: spec.name,
                namespace: spec.namespace,
              },
              spec: {
                ipAddressPools: spec.ipAddressPools,
              },
            },
            resourceOptions(args.resourceOptions, dependencies),
          ),
      ).pipe(Effect.map((advertisement) => [key, advertisement] as const))
    }),
  )

  return {
    namespaces: kubernetesNamespaces,
    releases: Object.fromEntries(
      Object.entries(releases).map(([key, release]) => [key, release.status.namespace]),
    ),
    metallb: {
      addressPools: Object.fromEntries(
        Object.entries(metallbPools).map(([key, resource]) => [key, resource.metadata.name]),
      ),
      l2Advertisements: Object.fromEntries(
        Object.entries(metallbAdvertisements).map(([key, resource]) => [
          key,
          resource.metadata.name,
        ]),
      ),
    },
  }
})
