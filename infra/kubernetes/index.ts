import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  decodeHelmReleaseInventory,
  decodeMetalLbAddressPoolInventory,
  decodeMetalLbL2AdvertisementInventory,
  decodeNamespaceInventory,
} from "@dsqr/model"
import { runPulumiProgram } from "@dsqr/pulumi-shared"
import { Effect } from "effect"

import { infrastructure } from "../../infra.config.ts"
import { createKubernetesStackEffect } from "./preflight.ts"

export const platform = runPulumiProgram(
  Effect.gen(function* () {
    const namespaces = yield* decodeNamespaceInventory(infrastructure.kubernetes.namespaces)
    const helmReleases = yield* decodeHelmReleaseInventory(infrastructure.kubernetes.helmReleases)
    const metallbAddressPools = yield* decodeMetalLbAddressPoolInventory(
      infrastructure.kubernetes.metallb.addressPools,
    )
    const metallbL2Advertisements = yield* decodeMetalLbL2AdvertisementInventory(
      infrastructure.kubernetes.metallb.l2Advertisements,
    )

    return yield* createKubernetesStackEffect({
      stackRoot: path.dirname(fileURLToPath(import.meta.url)),
      namespaces,
      helmReleases,
      metallbAddressPools,
      metallbL2Advertisements,
    })
  }),
)
