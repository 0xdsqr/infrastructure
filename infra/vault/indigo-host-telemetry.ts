import type { VaultPkiIssuerConfig, VaultPkiIssuerInventory } from "@dsqr/pulumi-vault"

// Explicit host identities: no shared cluster credential and no subnet-wide
// AppRole login. Keep this inventory aligned with Indigo's NixOS node addresses.
export const indigoHostTelemetryNodes = [
  { host: "srv-lx-k8s-indigo-control-01", address: "10.10.80.100" },
  { host: "srv-lx-k8s-indigo-control-02", address: "10.10.80.101" },
  { host: "srv-lx-k8s-indigo-control-03", address: "10.10.80.102" },
  { host: "srv-lx-k8s-indigo-worker-01", address: "10.10.80.103" },
  { host: "srv-lx-k8s-indigo-worker-02", address: "10.10.80.104" },
  { host: "srv-lx-k8s-indigo-worker-03", address: "10.10.80.105" },
  { host: "srv-lx-k8s-indigo-worker-04", address: "10.10.80.106" },
  { host: "srv-lx-k8s-indigo-worker-05", address: "10.10.80.107" },
  { host: "srv-lx-k8s-indigo-worker-06", address: "10.10.80.108" },
] as const

export const indigoHostTelemetryIssuers = Object.fromEntries(
  indigoHostTelemetryNodes.map(({ host, address }) => [
    `indigoHostTelemetry-${host}`,
    {
      backend: "pki_int",
      certificatePurpose: "client",
      roleName: `${host.replace(/^srv-lx-k8s-/, "")}-telemetry-client`,
      policyName: `dsqr-labs-pki-${host.replace(/^srv-lx-k8s-/, "")}-telemetry-client`,
      allowedDomains: [`${host}.telemetry-client.home.arpa`],
      allowWildcardCertificates: false,
      generateLease: false,
      ttlHours: 720,
      maxTtlHours: 720,
      appRole: {
        backend: "approle",
        roleName: `${host.replace(/^srv-lx-k8s-/, "")}-telemetry-renewer`,
        secretIdBoundCidrs: [`${address}/32`],
        tokenBoundCidrs: [`${address}/32`],
        // Match the existing renewable host-agent enrollment pattern. Secret
        // IDs are issued out of band and stored only as host-scoped age files.
        secretIdNumUses: 0,
        secretIdTtlSeconds: 0,
        tokenTtlSeconds: 900,
        tokenMaxTtlSeconds: 900,
        tokenExplicitMaxTtlSeconds: 900,
        tokenNumUses: 0,
      },
    } satisfies VaultPkiIssuerConfig,
  ]),
) satisfies VaultPkiIssuerInventory
