import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import test from "node:test"
import { vault } from "../infra/vault/config.ts"
import { proxmox } from "../infra/proxmox/config.ts"

test("Retired cluster inventory cannot recreate old compute, manifests or authentication", () => {
  assert.equal(existsSync("gitops/clusters/hub-a/bootstrap/kustomization.yaml"), false)
  assert.equal(existsSync("gitops/clusters/hub-a/applications/kustomization.yaml"), false)
  assert.deepEqual(vault.policies.externalSecrets, {})
  assert.equal("externalSecretsKubernetesRole" in vault, false)
  assert.equal("hubATraefikOrigin" in vault.pkiIssuers, false)
  assert.ok(
    Object.values(vault.externalSecretsKubernetesAuthBoundaries).every(
      (b) => b.backend.path === "kubernetes-indigo",
    ),
  )
  assert.ok(Object.values(proxmox.vms).every((v) => ![1200, 1210, 1220].includes(v.vmId)))
  assert.ok(vault.secretPaths.fidaraApi.path && vault.secretPaths.fidaraWeb.path)
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${path}/${e.name}`) : [`${path}/${e.name}`],
    )
  for (const file of walk("gitops").filter((p) => /\.(yaml|tmpl)$/.test(p))) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /hub-a|10\.10\.30\.(103|104|105|200)(?!\d)/,
      file,
    )
  }
})
