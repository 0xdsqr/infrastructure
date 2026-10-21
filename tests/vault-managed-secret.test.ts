import assert from "node:assert/strict"
import test from "node:test"
import * as pulumi from "@pulumi/pulumi"
import { createVaultFoundationEffect } from "@dsqr/pulumi-vault"
import { runPulumiProgram } from "@dsqr/pulumi-shared"
import { vault } from "../infra/vault/config.ts"
import { byName, runPulumiMockProgram } from "./pulumi-state-helpers.ts"

test("Managed tunnel credentials are protected, secret-wrapped KV v2 resources", async () => {
  const deployment = await runPulumiMockProgram({
    program: () => runPulumiProgram(createVaultFoundationEffect({
      connection: { address: "https://vault.example.test:8200", token: "test-token" },
      resourceNames: vault.resourceNames,
      kv: vault.kv,
      secretPaths: vault.secretPaths,
      humanAdminPolicy: vault.policies.humanAdmin,
      externalSecretsPolicies: vault.policies.externalSecrets,
      externalSecretsKubernetesRole: vault.externalSecretsKubernetesRole,
      pkiIssuers: { gatewayCaddy: vault.pkiIssuers.gatewayCaddy },
      audit: vault.audit,
      managedKvSecrets: {
        "indigo-cloudflare-tunnel-token": {
          path: vault.secretPaths.indigoCloudflareTunnel.path,
          dataJson: JSON.stringify({ token: "test-only-token" }),
        },
      },
    })),
    outputs: result => ({ kv: result.mounts.kv }),
    project: "vault-homelab",
  })
  const resource = byName(deployment.captured, "indigo-cloudflare-tunnel-token")
  assert.equal(resource.type, "vault:kv/secretV2:SecretV2")
  assert.equal(resource.opts.protect, true)
  assert.equal(resource.props.deleteAllVersions, false)
  assert.equal(resource.props.name, vault.secretPaths.indigoCloudflareTunnel.path)
  assert.equal(await pulumi.isSecret(pulumi.output(resource.props.dataJson)), true)
})
