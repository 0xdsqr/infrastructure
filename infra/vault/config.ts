import type {
  VaultAuditConfig,
  VaultExternalSecretsPolicyConfig,
  VaultExternalSecretsKubernetesAuthBoundaryInventory,
  VaultHumanAdminPolicyConfig,
  VaultKubernetesAuthRoleConfig,
  VaultKvMountConfig,
  VaultPkiIssuerInventory,
  VaultRaftSnapshotAppRoleConfig,
  VaultFoundationResourceNames,
  VaultSecretPathInventory,
} from "@dsqr/pulumi-vault"
import { indigoKubernetesCaCert } from "./certificates.ts"

const resourceNames = {
  provider: "vault",
  kvMount: "kv",
  kvConfig: "kv-config",
  humanAdminPolicy: "human-admin-policy",
  externalSecretsTokenSelfPolicy: "external-secrets-token-self-policy",
  externalSecretsKubernetesRole: "external-secrets-kubernetes-role-hub-a",
  audit: "audit",
} satisfies VaultFoundationResourceNames

const kv = {
  path: "kv",
  description: "Homelab KV v2 secrets managed by Vault.",
  maxVersions: 10,
  casRequired: false,
} satisfies VaultKvMountConfig

const secretPaths = {
  dotdevWeb: {
    path: "homelab/apps/dsqr/dotdev-web",
    description: "Runtime secrets for dsqr.dev web and shared dsqr app workloads.",
    fields: ["AUTH_SECRET", "DATABASE_URL", "RESEND_API_KEY", "S3_ACCESS_KEY", "S3_SECRET_KEY"],
  },
  dotdevStudio: {
    path: "homelab/apps/dsqr/dotdev-studio",
    description: "Reserved runtime secret path for studio.dsqr.dev.",
    fields: ["AUTH_SECRET", "DATABASE_URL", "RESEND_API_KEY", "S3_ACCESS_KEY", "S3_SECRET_KEY"],
  },
  fidaraApi: {
    path: "homelab/apps/fidara/api",
    description: "Runtime secrets for the Fidara API.",
    fields: ["DATABASE_URL", "FIDARA_API_KEY_PEPPER", "FIDARA_API_KEYS"],
  },
  fidaraWeb: {
    path: "homelab/apps/fidara/web",
    description: "Runtime secrets for the Fidara web app.",
    fields: [
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
      "FIDARA_API_KEY_PEPPER",
      "FIDARA_INTERNAL_API_KEY",
    ],
  },
  tastingsWithTayShared: {
    path: "homelab/apps/tastingswithtay/shared",
    description: "Shared runtime secrets for Tastings with Tay workloads.",
    fields: [
      "AUTH_SECRET",
      "DATABASE_URL",
      "DISCORD_CLIENT_SECRET",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
    ],
  },
  tastingsWithTayWeb: {
    path: "homelab/apps/tastingswithtay/web",
    description: "Runtime secrets for the Tastings with Tay public web app.",
    fields: [
      "AUTH_SECRET",
      "DATABASE_URL",
      "DISCORD_CLIENT_SECRET",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
    ],
  },
  tastingsWithTayAdmin: {
    path: "homelab/apps/tastingswithtay/admin",
    description: "Runtime secrets for the Tastings with Tay admin app.",
    fields: [
      "AUTH_SECRET",
      "DATABASE_URL",
      "DISCORD_CLIENT_SECRET",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
    ],
  },
  argocdFidaraRepo: {
    path: "homelab/platform/argocd/repos/fidara",
    description: "Argo CD private repository credentials for Fidara.",
    fields: ["type", "url", "username", "password"],
  },
  argocdGithubWebhook: {
    path: "homelab/platform/argocd/webhooks/github",
    description: "Shared HMAC secret for authenticated GitHub webhook deliveries to Argo CD.",
    fields: ["secret"],
  },
  githubHomelabToken: {
    path: "homelab/platform/github/homelab-token",
    description: "Temporary shared GitHub token while narrower tokens are split out.",
    fields: ["token"],
  },
  githubGhcrPull: {
    path: "homelab/platform/github/ghcr-pull",
    description:
      "Canonical GHCR pull credentials rendered into namespace dockerconfigjson secrets.",
    fields: ["server", "username", "password", "email"],
  },
  githubArgoRepoRead: {
    path: "homelab/platform/github/argocd-repo-read",
    description: "Canonical GitHub repository read token for Argo CD.",
    fields: ["username", "password"],
  },
  cloudflare: {
    path: "homelab/infra/cloudflare",
    description: "Cloudflare account, zone, tunnel, and API token inputs.",
    fields: [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_R2_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_DSQR_DEV_ZONE_ID",
      "CLOUDFLARE_TWT_ZONE_ID",
      "CLOUDFLARE_FIDARA_ZONE_ID",
      "CLOUDFLARE_TUNNEL_SECRET",
    ],
  },
  postgresKhaos: {
    path: "homelab/infra/postgres/srv-lx-khaos",
    description: "Shared Postgres endpoint metadata and administrative credentials for Khaos.",
    fields: ["HOST", "PORT", "ADMIN_DATABASE_URL"],
  },
  postgresGrafana: {
    path: "homelab/infra/postgres/srv-lx-khaos/databases/grafana",
    description: "Grafana database credentials on Khaos Postgres.",
    fields: ["DATABASE_URL", "PGUSER", "PGPASSWORD"],
  },
  postgresFidara: {
    path: "homelab/infra/postgres/srv-lx-khaos/databases/fidara",
    description: "Fidara database credentials on Khaos Postgres.",
    fields: ["DATABASE_URL", "PGUSER", "PGPASSWORD"],
  },
  postgresFidaraDev: {
    path: "homelab/infra/postgres/srv-lx-khaos/databases/fidara_dev",
    description: "Fidara development database credentials on Khaos Postgres.",
    fields: ["DATABASE_URL", "PGUSER", "PGPASSWORD"],
  },
  postgresTastingsWithTay: {
    path: "homelab/infra/postgres/srv-lx-khaos/databases/tastingswithtay",
    description: "Tastings with Tay database credentials on Khaos Postgres.",
    fields: ["DATABASE_URL", "PGUSER", "PGPASSWORD"],
  },
  postgresDsqrDotdev: {
    path: "homelab/infra/postgres/srv-lx-khaos/databases/dsqr-dotdev",
    description: "dsqr.dev database credentials on Khaos Postgres.",
    fields: ["DATABASE_URL", "PGUSER", "PGPASSWORD"],
  },
  postgresTcgPriceGuide: {
    path: "homelab/infra/postgres/srv-lx-khaos/databases/tcg-price-guide",
    description: "TCG price guide database credentials on Khaos Postgres.",
    fields: ["DATABASE_URL", "PGUSER", "PGPASSWORD"],
  },
  rustfsKhaos: {
    path: "homelab/infra/rustfs/srv-lx-khaos",
    description: "RustFS endpoint and root access credentials.",
    fields: ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY"],
  },
  vaultServer: {
    path: "homelab/infra/vault/srv-lx-vault",
    description: "Dedicated Vault endpoint metadata. Do not store root token or unseal keys here.",
    fields: ["VAULT_ADDR"],
  },
  indigoBootstrapSmokeTest: {
    path: "dsqr-labs/clusters/indigo/bootstrap/eso-smoke-test",
    description: "Harmless validation data for the Indigo External Secrets bootstrap path.",
    fields: ["message"],
  },
} satisfies VaultSecretPathInventory

const humanAdminPolicy = {
  name: "homelab-human-admin",
} satisfies VaultHumanAdminPolicyConfig

const audit = {
  enabled: true,
  type: "file",
  path: "file",
  description: "Homelab Vault audit log.",
  options: {
    file_path: "/var/lib/vault/audit.log",
  },
} satisfies VaultAuditConfig

const externalSecretsPolicies = {
  dotdevWeb: {
    name: "hub-a-external-secrets-dotdev-web",
    readPaths: [secretPaths.dotdevWeb.path],
  },
  dotdevStudio: {
    name: "hub-a-external-secrets-dotdev-studio",
    readPaths: [secretPaths.dotdevStudio.path],
  },
  fidaraApi: {
    name: "hub-a-external-secrets-fidara-api",
    readPaths: [secretPaths.fidaraApi.path],
  },
  fidaraWeb: {
    name: "hub-a-external-secrets-fidara-web",
    readPaths: [secretPaths.fidaraWeb.path],
  },
  tastingsWithTayShared: {
    name: "hub-a-external-secrets-tastingswithtay-shared",
    readPaths: [secretPaths.tastingsWithTayShared.path],
  },
  tastingsWithTayWeb: {
    name: "hub-a-external-secrets-tastingswithtay-web",
    readPaths: [secretPaths.tastingsWithTayWeb.path],
  },
  tastingsWithTayAdmin: {
    name: "hub-a-external-secrets-tastingswithtay-admin",
    readPaths: [secretPaths.tastingsWithTayAdmin.path],
  },
  argocdFidaraRepo: {
    name: "hub-a-external-secrets-argocd-fidara-repo",
    readPaths: [secretPaths.argocdFidaraRepo.path],
  },
  argocdGithubWebhook: {
    name: "hub-a-external-secrets-argocd-github-webhook",
    readPaths: [secretPaths.argocdGithubWebhook.path],
  },
  githubArgoRepoRead: {
    name: "hub-a-external-secrets-github-argocd-repo-read",
    readPaths: [secretPaths.githubArgoRepoRead.path],
  },
  githubGhcrPull: {
    name: "hub-a-external-secrets-github-ghcr-pull",
    readPaths: [secretPaths.githubGhcrPull.path],
  },
} satisfies Readonly<Record<string, VaultExternalSecretsPolicyConfig>>

const externalSecretsKubernetesRole = {
  backend: "kubernetes",
  roleName: "hub-a-external-secrets",
  tokenSelfPolicyName: "hub-a-external-secrets-token-self",
  boundServiceAccountNames: ["external-secrets"],
  boundServiceAccountNamespaces: ["external-secrets"],
  tokenTtlSeconds: 1_200,
  tokenMaxTtlSeconds: 3_600,
  tokenExplicitMaxTtlSeconds: 3_600,
} satisfies VaultKubernetesAuthRoleConfig

const externalSecretsKubernetesAuthBoundaries = {
  indigo: {
    backend: {
      path: "kubernetes-indigo",
      description: "Kubernetes authentication for the isolated Indigo cluster.",
      kubernetesHost: "https://10.10.80.10:6443",
      kubernetesCaCert: indigoKubernetesCaCert,
      disableLocalCaJwt: true,
    },
    policies: {
      bootstrapSmokeTest: {
        name: "indigo-external-secrets-bootstrap-smoke-test",
        readPaths: [secretPaths.indigoBootstrapSmokeTest.path],
        resourceName: "external-secrets-policy-indigo-bootstrap-smoke-test",
      },
    },
    role: {
      backend: "kubernetes-indigo",
      roleName: "indigo-external-secrets",
      tokenSelfPolicyName: "indigo-external-secrets-token-self",
      boundServiceAccountNames: ["external-secrets"],
      boundServiceAccountNamespaces: ["external-secrets"],
      tokenTtlSeconds: 1_200,
      tokenMaxTtlSeconds: 3_600,
      tokenExplicitMaxTtlSeconds: 3_600,
    },
    resourceNames: {
      authBackend: "kubernetes-auth-backend-indigo",
      authBackendConfig: "kubernetes-auth-backend-config-indigo",
      tokenSelfPolicy: "external-secrets-token-self-policy-indigo",
      kubernetesRole: "external-secrets-kubernetes-role-indigo",
    },
  },
} satisfies VaultExternalSecretsKubernetesAuthBoundaryInventory

const renewableAppRoleDefaults = {
  backend: "approle",
  secretIdNumUses: 0,
  secretIdTtlSeconds: 0,
  tokenTtlSeconds: 900,
  tokenMaxTtlSeconds: 900,
  tokenExplicitMaxTtlSeconds: 900,
  tokenNumUses: 0,
} as const

const raftSnapshotAppRole = {
  backend: "approle",
  roleName: "vault-raft-snapshot",
  roleId: "87b5b960-f1e8-4cc0-8d23-9ba8fcb07611",
  policyName: "homelab-vault-raft-snapshot",
  secretIdBoundCidrs: ["127.0.0.1/32", "::1/128", "10.10.30.110/32"],
  tokenBoundCidrs: ["127.0.0.1/32", "::1/128", "10.10.30.110/32"],
  tokenTtlSeconds: 900,
  tokenMaxTtlSeconds: 900,
  tokenExplicitMaxTtlSeconds: 900,
} satisfies VaultRaftSnapshotAppRoleConfig

const pkiIssuers = {
  vaultListener: {
    backend: "pki_int",
    roleName: "vault-listener",
    policyName: "homelab-pki-vault-listener",
    allowedDomains: ["vault.service.home.arpa"],
    allowWildcardCertificates: false,
    generateLease: false,
    ttlHours: 720,
    maxTtlHours: 720,
    appRole: {
      ...renewableAppRoleDefaults,
      roleName: "vault-listener-renewer",
      secretIdBoundCidrs: ["127.0.0.1/32", "::1/128", "10.10.30.110/32"],
      tokenBoundCidrs: ["127.0.0.1/32", "::1/128", "10.10.30.110/32"],
    },
  },
  postgresKnoxListener: {
    backend: "pki_int",
    roleName: "postgres-knox-listener",
    policyName: "homelab-pki-postgres-knox-listener",
    allowedDomains: ["postgres.service.home.arpa"],
    allowWildcardCertificates: false,
    generateLease: false,
    ttlHours: 720,
    maxTtlHours: 720,
    appRole: {
      ...renewableAppRoleDefaults,
      roleName: "postgres-knox-listener-renewer",
      secretIdBoundCidrs: ["10.10.30.109/32"],
      tokenBoundCidrs: ["10.10.30.109/32"],
    },
  },
  proxmoxListener: {
    backend: "pki_int",
    roleName: "proxmox-dell-r730xd-listener",
    policyName: "homelab-pki-proxmox-dell-r730xd-listener",
    allowedDomains: ["proxmox.dell-r730xd.home.arpa"],
    allowWildcardCertificates: false,
    generateLease: false,
    ttlHours: 720,
    maxTtlHours: 720,
    appRole: {
      ...renewableAppRoleDefaults,
      roleName: "proxmox-dell-r730xd-listener-renewer",
      secretIdBoundCidrs: ["10.10.10.109/32"],
      tokenBoundCidrs: ["10.10.10.109/32"],
    },
  },
  rustfsKhaosListener: {
    backend: "pki_int",
    roleName: "rustfs-khaos-listener",
    policyName: "homelab-pki-rustfs-khaos-listener",
    allowedDomains: ["rustfs.service.home.arpa"],
    allowWildcardCertificates: false,
    generateLease: false,
    ttlHours: 720,
    maxTtlHours: 720,
    appRole: {
      ...renewableAppRoleDefaults,
      roleName: "rustfs-khaos-listener-renewer",
      roleId: "e8b1c7b0-da79-456a-b59b-60c9c849386b",
      secretIdBoundCidrs: ["10.10.30.107/32"],
      tokenBoundCidrs: ["10.10.30.107/32"],
    },
  },
  gatewayCaddy: {
    backend: "pki_int",
    roleName: "gateway-caddy-home-arpa",
    policyName: "homelab-pki-gateway-caddy-home-arpa",
    allowedDomains: [
      "argocd.hub-a.home.arpa",
      "exo.home.arpa",
      "exo.service.home.arpa",
      "grafana.home.arpa",
      "prometheus.home.arpa",
      "rustfs.home.arpa",
      "temporal.home.arpa",
      "vault.home.arpa",
    ],
    allowWildcardCertificates: false,
    generateLease: false,
    ttlHours: 720,
    maxTtlHours: 720,
    appRole: {
      ...renewableAppRoleDefaults,
      roleName: "gateway-caddy-pki-renewer",
      secretIdBoundCidrs: ["10.10.60.100/32"],
      tokenBoundCidrs: ["10.10.60.100/32"],
    },
  },
  hubATraefikOrigin: {
    backend: "pki_int",
    roleName: "hub-a-traefik-origin",
    policyName: "homelab-pki-hub-a-traefik-origin",
    allowedDomains: [
      "admin.tastingswithtay.com",
      "api.fidara.io",
      "argocd.hub-a.home.arpa",
      "argocd-hooks-hub-a.dsqr.dev",
      "dsqr.dev",
      "fidara.io",
      "labs.dsqr.dev",
      "studio.dsqr.dev",
      "tastingswithtay.com",
    ],
    allowWildcardCertificates: false,
    generateLease: true,
    ttlHours: 720,
    maxTtlHours: 720,
    kubernetesAuthRole: {
      backend: "kubernetes",
      roleName: "hub-a-traefik-origin-issuer",
      boundServiceAccountNames: ["traefik-origin-issuer"],
      boundServiceAccountNamespaces: ["traefik"],
      tokenTtlSeconds: 1_200,
      tokenMaxTtlSeconds: 3_600,
      tokenExplicitMaxTtlSeconds: 3_600,
    },
  },
  indigoGatewayOrigin: {
    backend: "pki_int",
    roleName: "indigo-gateway-origin",
    policyName: "homelab-pki-indigo-gateway-origin",
    allowedDomains: ["argocd.indigo.home.arpa", "gateway.indigo.home.arpa"],
    allowWildcardCertificates: false,
    generateLease: true,
    ttlHours: 720,
    maxTtlHours: 720,
    kubernetesAuthRole: {
      backend: "kubernetes-indigo",
      roleName: "indigo-gateway-origin-issuer",
      boundServiceAccountNames: ["gateway-origin-issuer"],
      boundServiceAccountNamespaces: ["gateway-system"],
      tokenTtlSeconds: 1_200,
      tokenMaxTtlSeconds: 3_600,
      tokenExplicitMaxTtlSeconds: 3_600,
    },
  },
} satisfies VaultPkiIssuerInventory

export const vault = {
  resourceNames,
  kv,
  secretPaths,
  policies: {
    humanAdmin: humanAdminPolicy,
    externalSecrets: externalSecretsPolicies,
  },
  externalSecretsKubernetesRole,
  externalSecretsKubernetesAuthBoundaries,
  raftSnapshotAppRole,
  pkiIssuers,
  audit,
} as const
