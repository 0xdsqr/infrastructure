import * as pulumi from "@pulumi/pulumi"
import { Effect, Redacted } from "effect"
import {
  firstDefined,
  PulumiResourceConfigError,
  requireConfigValueEffect,
  type PulumiConfigReader,
} from "@dsqr/pulumi-shared"

export type ProxmoxConnectionConfig = {
  endpoint: string
  apiToken: pulumi.Input<string>
  insecure: boolean
}

export type ProxmoxConnectionConfigSource = {
  readonly config?: PulumiConfigReader<pulumi.Input<string>> | undefined
  readonly environment?: ProxmoxConnectionEnvironment | undefined
}

export type ProxmoxConnectionEnvironment = {
  readonly endpoint?: string | undefined
  readonly apiToken?: pulumi.Input<string> | undefined
  readonly username?: string | undefined
  readonly tokenId?: string | undefined
  readonly tokenSecret?: Redacted.Redacted<string> | undefined
  readonly insecure?: boolean | undefined
  readonly allowInsecureLocalDev?: boolean | undefined
}

function readEndpoint(
  config: PulumiConfigReader<pulumi.Input<string>>,
  environment: ProxmoxConnectionEnvironment,
) {
  return firstDefined(config.get("endpoint"), environment.endpoint)
}

function readApiToken(
  config: PulumiConfigReader<pulumi.Input<string>>,
  environment: ProxmoxConnectionEnvironment,
) {
  return (
    config.getSecret("apiToken") ??
    environment.apiToken ??
    (() => {
      const { username, tokenId, tokenSecret } = environment

      if (!username || !tokenId || !tokenSecret) {
        return undefined
      }

      return pulumi.secret(`${username}!${tokenId}=${Redacted.value(tokenSecret)}`)
    })()
  )
}

function readInsecure(
  config: PulumiConfigReader<pulumi.Input<string>>,
  environment: ProxmoxConnectionEnvironment,
) {
  return config.getBoolean("insecure") ?? environment.insecure ?? false
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

export function validateProxmoxTransportEffect(
  endpoint: string,
  insecure: boolean,
  allowInsecureLocalDev: boolean,
): Effect.Effect<void, PulumiResourceConfigError> {
  return Effect.try({
    try: () => new URL(endpoint),
    catch: () =>
      new PulumiResourceConfigError({
        resource: "proxmox:connection",
        message: "Proxmox endpoint must be a valid absolute URL.",
      }),
  }).pipe(
    Effect.flatMap((url) => {
      if (url.username || url.password) {
        return Effect.fail(
          new PulumiResourceConfigError({
            resource: "proxmox:connection",
            message: "Proxmox endpoint must not contain embedded credentials.",
          }),
        )
      }

      const isExplicitLocalDev = allowInsecureLocalDev && isLoopbackHostname(url.hostname)

      if (url.protocol === "http:" && isExplicitLocalDev) {
        return Effect.void
      }

      if (url.protocol !== "https:") {
        return Effect.fail(
          new PulumiResourceConfigError({
            resource: "proxmox:connection",
            message:
              "Proxmox requires HTTPS. Plain HTTP is allowed only for an explicitly enabled loopback-only disposable development server.",
          }),
        )
      }

      if (insecure && !isExplicitLocalDev) {
        return Effect.fail(
          new PulumiResourceConfigError({
            resource: "proxmox:connection",
            message:
              "Proxmox TLS verification cannot be disabled outside an explicitly enabled loopback-only disposable development server.",
          }),
        )
      }

      return Effect.void
    }),
  )
}

export function loadProxmoxConnectionConfigEffect(source: ProxmoxConnectionConfigSource = {}) {
  return Effect.gen(function* () {
    const config = source.config ?? (yield* Effect.sync(() => new pulumi.Config("proxmox")))
    const environment = source.environment ?? {}
    const endpoint = yield* requireConfigValueEffect(
      readEndpoint(config, environment),
      "endpoint",
      ["proxmox:endpoint", "PROXMOX_BASE_URL", "PROXMOX_VE_ENDPOINT"],
    )

    const apiToken = yield* requireConfigValueEffect(
      readApiToken(config, environment),
      "api token",
      [
        "proxmox:apiToken",
        "PROXMOX_API_TOKEN",
        "PROXMOX_VE_API_TOKEN",
        "PROXMOX_USER + PROXMOX_TOKEN_ID + PROXMOX_TOKEN_SECRET",
      ],
    )
    const insecure = readInsecure(config, environment)
    const allowInsecureLocalDev =
      config.getBoolean("allowInsecureLocalDev") ?? environment.allowInsecureLocalDev ?? false

    yield* validateProxmoxTransportEffect(endpoint, insecure, allowInsecureLocalDev)

    return {
      endpoint,
      apiToken,
      insecure,
    } satisfies ProxmoxConnectionConfig
  })
}
