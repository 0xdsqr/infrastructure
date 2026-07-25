import {
  createProxmoxPlatformEffect,
  loadProxmoxConnectionConfigEffect,
} from "@dsqr/pulumi-proxmox"
import { decodeVmDefaults, decodeVmInventory } from "@dsqr/model"
import { runPulumiProgram } from "@dsqr/pulumi-shared"
import { Effect } from "effect"

import { infrastructure } from "../../infra.config.ts"
import { loadProxmoxEnvironment } from "./environment.ts"

export const proxmox = runPulumiProgram(
  loadProxmoxEnvironment().pipe(
    Effect.flatMap((environment) => loadProxmoxConnectionConfigEffect({ environment })),
    Effect.flatMap((connection) =>
      Effect.all({
        defaults: decodeVmDefaults(infrastructure.proxmox.defaults),
        inventory: decodeVmInventory(infrastructure.proxmox.vms),
      }).pipe(
        Effect.flatMap(({ defaults, inventory }) =>
          createProxmoxPlatformEffect({
            connection,
            defaults,
            inventory,
          }),
        ),
      ),
    ),
  ),
)
