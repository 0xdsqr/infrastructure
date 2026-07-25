import { strict as assert } from "node:assert"
import { test } from "node:test"

import * as pulumi from "@pulumi/pulumi"
import type { MockResourceArgs } from "@pulumi/pulumi/runtime"
import { Effect } from "effect"

import {
  createKubernetesPlatformEffect,
  planKubernetesPlatform,
  type KubernetesPlatformArgs,
} from "@dsqr/pulumi-kubernetes"

const resources: MockResourceArgs[] = []

await pulumi.runtime.setMocks(
  {
    call: (args) => args.inputs,
    newResource: (args) => {
      resources.push(args)
      return { id: `${args.name}-id`, state: args.inputs }
    },
  },
  "infrastructure",
  "dev",
  true,
)

const platformArgs = (
  helmReleases: KubernetesPlatformArgs["helmReleases"],
): KubernetesPlatformArgs => ({
  stackRoot: "/tmp/infrastructure",
  namespaces: {},
  helmReleases,
  metallbAddressPools: {},
  metallbL2Advertisements: {},
})

test("Kubernetes planning produces a deterministic dependency order", () => {
  const plan = Effect.runSync(
    planKubernetesPlatform(
      platformArgs({
        cilium: {
          releaseName: "cilium",
          namespace: "kube-system",
          chart: "cilium",
        },
        metallb: {
          releaseName: "metallb",
          namespace: "metallb-system",
          chart: "metallb",
          dependsOn: ["cilium"],
        },
        monitoring: {
          releaseName: "monitoring",
          namespace: "observability",
          chart: "monitoring",
          dependsOn: ["cilium"],
        },
      }),
    ),
  )

  assert.deepEqual(plan.releaseOrder, ["cilium", "metallb", "monitoring"])
})

test("Kubernetes validation fails before any resource registration", () => {
  const resourceCount = resources.length
  const error = Effect.runSync(
    Effect.flip(
      createKubernetesPlatformEffect(
        platformArgs({
          application: {
            releaseName: "application",
            namespace: "default",
            chart: "application",
            dependsOn: ["missing"],
          },
        }),
      ),
    ),
  )

  assert.match(error.message, /depends on unknown release missing/)
  assert.equal(resources.length, resourceCount)
})

test("Kubernetes planning rejects disabled dependencies and cycles", () => {
  const disabledDependency = Effect.runSync(
    Effect.flip(
      planKubernetesPlatform(
        platformArgs({
          foundation: {
            releaseName: "foundation",
            namespace: "default",
            chart: "foundation",
            enabled: false,
          },
          application: {
            releaseName: "application",
            namespace: "default",
            chart: "application",
            dependsOn: ["foundation"],
          },
        }),
      ),
    ),
  )
  assert.match(disabledDependency.message, /depends on disabled release foundation/)

  const cycle = Effect.runSync(
    Effect.flip(
      planKubernetesPlatform(
        platformArgs({
          first: {
            releaseName: "first",
            namespace: "default",
            chart: "first",
            dependsOn: ["second"],
          },
          second: {
            releaseName: "second",
            namespace: "default",
            chart: "second",
            dependsOn: ["first"],
          },
        }),
      ),
    ),
  )
  assert.match(cycle.message, /dependency graph contains a cycle/)
})

test("Kubernetes planning resolves MetalLB advertisements by metadata name", () => {
  const error = Effect.runSync(
    Effect.flip(
      planKubernetesPlatform({
        ...platformArgs({
          metallb: {
            releaseName: "metallb",
            namespace: "metallb-system",
            chart: "metallb",
          },
        }),
        metallbAddressPools: {
          ingress: {
            name: "ingress",
            namespace: "metallb-system",
            addresses: ["10.0.0.1/32"],
          },
        },
        metallbL2Advertisements: {
          default: {
            name: "default",
            namespace: "metallb-system",
            ipAddressPools: ["unknown"],
          },
        },
      }),
    ),
  )

  assert.match(error.message, /references unknown pool "unknown"/)
})

test("Kubernetes resolves same-named MetalLB pools within each namespace", () => {
  const plan = Effect.runSync(
    planKubernetesPlatform({
      ...platformArgs({
        metallb: {
          releaseName: "metallb",
          namespace: "metallb-system",
          chart: "metallb",
        },
      }),
      metallbAddressPools: {
        first: {
          name: "ingress",
          namespace: "first-system",
          addresses: ["10.0.0.1/32"],
        },
        second: {
          name: "ingress",
          namespace: "second-system",
          addresses: ["10.0.0.2/32"],
        },
      },
      metallbL2Advertisements: {
        second: {
          name: "default",
          namespace: "second-system",
          ipAddressPools: ["ingress"],
        },
      },
    }),
  )

  assert.deepEqual(plan.advertisementPoolKeys.second, ["second"])
})
