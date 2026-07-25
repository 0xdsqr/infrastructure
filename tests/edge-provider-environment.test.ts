import { strict as assert } from "node:assert"
import { test } from "node:test"

import { ConfigProvider, Effect, Exit, Redacted } from "effect"

import { loadCloudflareConfig } from "../infra/cloudflare/config.ts"
import { loadHetznerEnvironment } from "../infra/hetzner/environment.ts"
import { loadTailscaleEnvironment } from "../infra/tailscale/environment.ts"

const cloudflareEnvironment = new Map([
  ["CLOUDFLARE_ACCOUNT_ID", "account-id"],
  ["CLOUDFLARE_API_TOKEN", "api-token"],
  ["CLOUDFLARE_DSQR_DEV_ZONE_ID", "dsqr-zone"],
  ["CLOUDFLARE_FIDARA_ZONE_ID", "fidara-zone"],
  ["CLOUDFLARE_TWT_ZONE_ID", "twt-zone"],
  ["CLOUDFLARE_TUNNEL_SECRET", "tunnel-secret"],
])

test("Cloudflare checks every ambient credential and identifier", () => {
  const environment = Effect.runSync(
    loadCloudflareConfig().pipe(
      Effect.withConfigProvider(ConfigProvider.fromMap(cloudflareEnvironment)),
    ),
  )

  assert.equal(environment.accountId, "account-id")
  assert.equal(Redacted.value(environment.apiToken), "api-token")
  assert.equal(Redacted.value(environment.tunnelSecret), "tunnel-secret")

  const emptyToken = new Map(cloudflareEnvironment)
  emptyToken.set("CLOUDFLARE_API_TOKEN", "")
  assert.equal(
    Exit.isFailure(
      Effect.runSyncExit(
        loadCloudflareConfig().pipe(Effect.withConfigProvider(ConfigProvider.fromMap(emptyToken))),
      ),
    ),
    true,
  )
})

test("Tailscale checks ambient OAuth credentials and accepts an optional tailnet", () => {
  const provider = ConfigProvider.fromMap(
    new Map([
      ["TAILSCALE_OAUTH_CLIENT_ID", "client-id"],
      ["TAILSCALE_OAUTH_CLIENT_SECRET", "client-secret"],
      ["TAILSCALE_TAILNET", "example.ts.net"],
    ]),
  )
  const environment = Effect.runSync(
    loadTailscaleEnvironment().pipe(Effect.withConfigProvider(provider)),
  )

  assert.equal(Redacted.value(environment.oauthClientId), "client-id")
  assert.equal(Redacted.value(environment.oauthClientSecret), "client-secret")
  assert.equal(environment.tailnet, "example.ts.net")

  const missingCredentials = Effect.runSyncExit(
    loadTailscaleEnvironment().pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map()))),
  )
  assert.equal(Exit.isFailure(missingCredentials), true)

  const emptyCredentials = Effect.runSyncExit(
    loadTailscaleEnvironment().pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["TAILSCALE_OAUTH_CLIENT_ID", ""],
            ["TAILSCALE_OAUTH_CLIENT_SECRET", ""],
          ]),
        ),
      ),
    ),
  )
  assert.equal(Exit.isFailure(emptyCredentials), true)
})

test("Hetzner checks the ambient provider token without constructing a provider", () => {
  const environment = Effect.runSync(
    loadHetznerEnvironment().pipe(
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["HCLOUD_TOKEN", "test-token"]]))),
    ),
  )
  assert.equal(Redacted.value(environment), "test-token")

  const missingToken = Effect.runSyncExit(
    loadHetznerEnvironment().pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map()))),
  )
  assert.equal(Exit.isFailure(missingToken), true)

  const emptyToken = Effect.runSyncExit(
    loadHetznerEnvironment().pipe(
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["HCLOUD_TOKEN", ""]]))),
    ),
  )
  assert.equal(Exit.isFailure(emptyToken), true)
})
