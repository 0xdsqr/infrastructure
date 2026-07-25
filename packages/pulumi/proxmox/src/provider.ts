import * as proxmox from "@muhlba91/pulumi-proxmoxve"
import * as pulumi from "@pulumi/pulumi"

import { registerPulumiResource } from "@dsqr/pulumi-shared"

import type { ProxmoxConnectionConfig } from "./config.ts"

export const createProxmoxProviderEffect = (
  name: string,
  connection: ProxmoxConnectionConfig,
  options?: pulumi.ResourceOptions,
) =>
  registerPulumiResource(name, () => {
    const args = {
      endpoint: connection.endpoint,
      apiToken: pulumi.secret(connection.apiToken),
      insecure: connection.insecure,
    }

    return options ? new proxmox.Provider(name, args, options) : new proxmox.Provider(name, args)
  })
