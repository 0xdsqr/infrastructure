import * as pulumi from "@pulumi/pulumi"
import * as vault from "@pulumi/vault"
import { isIP } from "node:net"
import { Effect } from "effect"

import {
  PulumiResourceConfigError,
  firstDefined,
  registerPulumiResource,
  requireConfigValueEffect,
  requireResourceConfigEffect,
  type MissingPulumiConfigError,
  type PulumiConfigReader,
} from "@dsqr/pulumi-shared"

export type VaultConnectionConfig = {
  readonly address: pulumi.Input<string>
  readonly token: pulumi.Input<string>
  readonly caCertFile?: pulumi.Input<string> | undefined
  readonly skipTlsVerify?: pulumi.Input<boolean> | undefined
}

export type VaultConnectionEnvironment = {
  readonly address?: string | undefined
  readonly token?: pulumi.Input<string> | undefined
  readonly caCertFile?: string | undefined
  readonly skipTlsVerify?: boolean | undefined
  readonly allowInsecureLocalDev?: boolean | undefined
}

export type VaultKvMountConfig = {
  readonly path: string
  readonly description: string
  readonly maxVersions: number
  readonly casRequired: boolean
}

export type VaultSecretPathSpec = {
  readonly path: string
  readonly description: string
  readonly fields: readonly string[]
}

export type VaultSecretPathInventory = Readonly<Record<string, VaultSecretPathSpec>>

export type VaultExternalSecretsPolicyConfig = {
  readonly name: string
  readonly readPaths: readonly string[]
  readonly resourceName?: string | undefined
}

export type VaultKubernetesAuthRoleConfig = {
  readonly backend: string
  readonly roleName: string
  readonly tokenSelfPolicyName: string
  readonly boundServiceAccountNames: readonly string[]
  readonly boundServiceAccountNamespaces: readonly string[]
  readonly tokenTtlSeconds: number
  readonly tokenMaxTtlSeconds: number
  readonly tokenExplicitMaxTtlSeconds: number
}

export type VaultExternalSecretsKubernetesAuthBoundaryConfig = {
  readonly backend: {
    readonly path: string
    readonly description: string
    readonly kubernetesHost: string
    readonly kubernetesCaCert: string
    readonly disableLocalCaJwt: boolean
  }
  readonly policies: Readonly<Record<string, VaultExternalSecretsPolicyConfig>>
  readonly role: VaultKubernetesAuthRoleConfig
  readonly resourceNames: {
    readonly authBackend: string
    readonly authBackendConfig: string
    readonly tokenSelfPolicy: string
    readonly kubernetesRole: string
  }
}

export type VaultExternalSecretsKubernetesAuthBoundaryInventory = Readonly<
  Record<string, VaultExternalSecretsKubernetesAuthBoundaryConfig>
>

export type VaultHumanAdminPolicyConfig = {
  readonly name: string
}

export type VaultRaftSnapshotAppRoleConfig = {
  readonly backend: string
  readonly roleName: string
  readonly roleId: string
  readonly policyName: string
  readonly secretIdBoundCidrs: readonly string[]
  readonly tokenBoundCidrs: readonly string[]
  readonly tokenTtlSeconds: number
  readonly tokenMaxTtlSeconds: number
  readonly tokenExplicitMaxTtlSeconds: number
}

export type VaultPkiAppRoleConfig = {
  readonly backend: string
  readonly roleName: string
  readonly roleId?: string | undefined
  readonly secretIdBoundCidrs: readonly string[]
  readonly tokenBoundCidrs: readonly string[]
  readonly secretIdNumUses: number
  readonly secretIdTtlSeconds: number
  readonly tokenTtlSeconds: number
  readonly tokenMaxTtlSeconds: number
  readonly tokenExplicitMaxTtlSeconds: number
  readonly tokenNumUses: number
}

export type VaultPkiKubernetesAuthRoleConfig = {
  readonly backend: string
  readonly roleName: string
  readonly boundServiceAccountNames: readonly string[]
  readonly boundServiceAccountNamespaces: readonly string[]
  readonly tokenTtlSeconds: number
  readonly tokenMaxTtlSeconds: number
  readonly tokenExplicitMaxTtlSeconds: number
}

export type VaultPkiIssuerConfig = {
  readonly backend: string
  readonly roleName: string
  readonly policyName: string
  readonly allowedDomains: readonly string[]
  readonly allowWildcardCertificates: boolean
  readonly generateLease: boolean
  readonly ttlHours: number
  readonly maxTtlHours: number
  readonly resourceNames?:
    | {
        readonly role?: string | undefined
        readonly policy?: string | undefined
        readonly appRole?: string | undefined
        readonly kubernetesAuthRole?: string | undefined
      }
    | undefined
  readonly appRole?: VaultPkiAppRoleConfig | undefined
  readonly kubernetesAuthRole?: VaultPkiKubernetesAuthRoleConfig | undefined
}

export type VaultPkiIssuerInventory = Readonly<Record<string, VaultPkiIssuerConfig>>

export type VaultAuditConfig = {
  readonly enabled: boolean
  readonly type: "file"
  readonly path: string
  readonly description: string
  readonly options: Readonly<Record<string, string>>
}

export type VaultFoundationResourceNames = {
  readonly provider: string
  readonly kvMount: string
  readonly kvConfig: string
  readonly humanAdminPolicy: string
  readonly externalSecretsTokenSelfPolicy: string
  readonly externalSecretsKubernetesRole: string
  readonly audit: string
}

export type VaultFoundationResourceOptions = Omit<
  pulumi.CustomResourceOptions,
  "dependsOn" | "protect" | "provider"
>

export type VaultFoundationArgs = {
  readonly connection: VaultConnectionConfig
  readonly kv: VaultKvMountConfig
  readonly secretPaths: VaultSecretPathInventory
  readonly humanAdminPolicy: VaultHumanAdminPolicyConfig
  readonly externalSecretsPolicies: Readonly<Record<string, VaultExternalSecretsPolicyConfig>>
  readonly externalSecretsKubernetesRole: VaultKubernetesAuthRoleConfig
  readonly externalSecretsKubernetesAuthBoundaries?:
    | VaultExternalSecretsKubernetesAuthBoundaryInventory
    | undefined
  readonly raftSnapshotAppRole?: VaultRaftSnapshotAppRoleConfig | undefined
  readonly pkiIssuers: VaultPkiIssuerInventory
  readonly audit: VaultAuditConfig
  readonly resourceNames: VaultFoundationResourceNames
  readonly providerOptions?: pulumi.ResourceOptions | undefined
  readonly resourceOptions?: VaultFoundationResourceOptions | undefined
}

type VaultCapability = "create" | "read" | "update" | "delete" | "list" | "sudo"

export function loadVaultConnectionConfigEffect(
  source: {
    readonly config?: PulumiConfigReader<pulumi.Output<string>> | undefined
    readonly environment?: VaultConnectionEnvironment | undefined
  } = {},
): Effect.Effect<VaultConnectionConfig, MissingPulumiConfigError | PulumiResourceConfigError> {
  return Effect.gen(function* () {
    const config = source.config ?? (yield* Effect.sync(() => new pulumi.Config("vault")))
    const environment = source.environment ?? {}
    const address = yield* requireConfigValueEffect(
      firstDefined(config.get("address"), environment.address),
      "Vault address",
      ["pulumi config set vault:address <url>", "VAULT_ADDR", "VAULT_ADDRESS"],
    )
    const caCertFile = firstDefined(config.get("caCertFile"), environment.caCertFile)
    const skipTlsVerify = config.getBoolean("skipTlsVerify") ?? environment.skipTlsVerify ?? false
    const allowInsecureLocalDev =
      config.getBoolean("allowInsecureLocalDev") ?? environment.allowInsecureLocalDev ?? false

    yield* validateVaultTransportEffect(address, skipTlsVerify, allowInsecureLocalDev)

    const token = yield* requireConfigValueEffect(
      config.getSecret("token") ?? environment.token,
      "Vault token",
      ["pulumi config set --secret vault:token <token>", "VAULT_TOKEN"],
    )

    return {
      address,
      token,
      ...(caCertFile ? { caCertFile } : undefined),
      ...(skipTlsVerify ? { skipTlsVerify } : undefined),
    } satisfies VaultConnectionConfig
  })
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

export function validateVaultTransportEffect(
  address: string,
  skipTlsVerify: boolean,
  allowInsecureLocalDev: boolean,
): Effect.Effect<void, PulumiResourceConfigError> {
  return Effect.try({
    try: () => new URL(address),
    catch: () =>
      new PulumiResourceConfigError({
        resource: "vault:connection",
        message: "Vault address must be a valid absolute URL.",
      }),
  }).pipe(
    Effect.flatMap((url) => {
      if (url.username || url.password) {
        return Effect.fail(
          new PulumiResourceConfigError({
            resource: "vault:connection",
            message: "Vault address must not contain embedded credentials.",
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
            resource: "vault:connection",
            message:
              "Vault requires HTTPS. Plain HTTP is allowed only for an explicitly enabled loopback-only disposable development server.",
          }),
        )
      }

      if (skipTlsVerify && !isExplicitLocalDev) {
        return Effect.fail(
          new PulumiResourceConfigError({
            resource: "vault:connection",
            message:
              "Vault TLS verification cannot be disabled outside an explicitly enabled loopback-only disposable development server.",
          }),
        )
      }

      return Effect.void
    }),
  )
}

function listLiteral(values: readonly string[]) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`
}

function policyRule(path: string, capabilities: readonly VaultCapability[]) {
  return [
    `path ${JSON.stringify(path)} {`,
    `  capabilities = ${listLiteral(capabilities)}`,
    "}",
  ].join("\n")
}

export type VaultSecretPathOutput = {
  readonly path: string
  readonly kvV2DataPath: string
  readonly fields: readonly string[]
  readonly description: string
}

function relativeKvPathEffect(
  mountPath: string,
  fullPath: string,
): Effect.Effect<string, PulumiResourceConfigError> {
  const prefix = `${mountPath}/`

  if (fullPath.startsWith(prefix)) {
    return Effect.succeed(fullPath.slice(prefix.length))
  }

  return Effect.fail(
    new PulumiResourceConfigError({
      resource: `vault-secret-path:${fullPath}`,
      message: `Vault path "${fullPath}" must live under KV mount "${mountPath}".`,
    }),
  )
}

export function renderKvV2ReadPolicy(mountPath: string, paths: readonly string[]) {
  return paths
    .flatMap((path) => [
      policyRule(`${mountPath}/data/${path}`, ["read"]),
      policyRule(`${mountPath}/metadata/${path}`, ["read"]),
    ])
    .join("\n\n")
}

export function renderPkiIssuePolicy(backend: string, roleName: string) {
  return policyRule(`${backend}/issue/${roleName}`, ["create", "update"])
}

export function renderTokenSelfPolicy() {
  return [
    policyRule("auth/token/lookup-self", ["read"]),
    policyRule("auth/token/renew-self", ["update"]),
    policyRule("auth/token/revoke-self", ["update"]),
  ].join("\n\n")
}

export function renderRaftSnapshotPolicy() {
  return policyRule("sys/storage/raft/snapshot", ["read"])
}

export function validateRaftSnapshotAppRoleEffect(
  role: VaultRaftSnapshotAppRoleConfig,
): Effect.Effect<void, PulumiResourceConfigError> {
  return Effect.gen(function* () {
    const resource = "vault:raft-snapshot-approle"

    yield* requireResourceConfigEffect(
      isNormalizedMountName(role.backend) && role.roleName.length > 0 && role.policyName.length > 0,
      resource,
      "Raft snapshot AppRole names and backend must be normalized and non-empty.",
    )
    yield* requireResourceConfigEffect(
      role.roleId.length > 0,
      resource,
      "Raft snapshot AppRole requires a stable explicit role ID.",
    )
    yield* requireResourceConfigEffect(
      isUniqueNonEmpty(role.secretIdBoundCidrs) &&
        isUniqueNonEmpty(role.tokenBoundCidrs) &&
        role.secretIdBoundCidrs.every(isValidCidr) &&
        role.tokenBoundCidrs.every(isValidCidr) &&
        !role.secretIdBoundCidrs.some(isBroadCidr) &&
        !role.tokenBoundCidrs.some(isBroadCidr),
      resource,
      "Raft snapshot AppRole must bind secret IDs and tokens to explicit source CIDRs.",
    )
    yield* requireResourceConfigEffect(
      isPositiveInteger(role.tokenTtlSeconds) &&
        isPositiveInteger(role.tokenMaxTtlSeconds) &&
        isPositiveInteger(role.tokenExplicitMaxTtlSeconds) &&
        role.tokenMaxTtlSeconds >= role.tokenTtlSeconds &&
        role.tokenExplicitMaxTtlSeconds >= role.tokenMaxTtlSeconds &&
        role.tokenExplicitMaxTtlSeconds <= 3_600,
      resource,
      "Raft snapshot AppRole token lifetimes must be ordered and capped at one hour.",
    )
  })
}

function isDnsName(value: string) {
  if (value.length === 0 || value.length > 253 || value !== value.toLowerCase()) {
    return false
  }

  const labels = value.split(".")

  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  )
}

function isBroadCidr(value: string) {
  return value === "0.0.0.0/0" || value === "::/0"
}

function isValidCidr(value: string) {
  const [address, prefix, extra] = value.split("/")
  if (!address || !prefix || extra !== undefined || !/^\d+$/.test(prefix)) {
    return false
  }

  const family = isIP(address)
  const bits = Number(prefix)
  return (family === 4 && bits >= 0 && bits <= 32) || (family === 6 && bits >= 0 && bits <= 128)
}

const isNonNegativeInteger = (value: number) => Number.isInteger(value) && value >= 0

const isPositiveInteger = (value: number) => Number.isInteger(value) && value > 0

const isUniqueNonEmpty = (values: readonly string[]) =>
  values.length > 0 &&
  values.every((value) => value.trim().length > 0) &&
  new Set(values).size === values.length

const isHttpsUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0
  } catch {
    return false
  }
}

export function validatePkiIssuerInventoryEffect(
  issuers: VaultPkiIssuerInventory,
): Effect.Effect<void, PulumiResourceConfigError> {
  return Effect.gen(function* () {
    const roleNames = new Set<string>()
    const policyNames = new Set<string>()
    const appRoleNames = new Set<string>()
    const kubernetesAuthRoleNames = new Set<string>()

    if (Object.keys(issuers).length === 0) {
      return yield* Effect.fail(
        new PulumiResourceConfigError({
          resource: "vault:pki-issuers",
          message: "At least one scoped PKI issuer role is required.",
        }),
      )
    }

    for (const [key, issuer] of Object.entries(issuers)) {
      const resource = `vault:pki-issuer:${key}`

      if (!issuer.backend || issuer.backend.includes("/") || issuer.backend.includes("*")) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource,
            message: `PKI issuer "${key}" must use a normalized backend mount name.`,
          }),
        )
      }

      if (!issuer.roleName || roleNames.has(issuer.roleName)) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource,
            message: `PKI issuer "${key}" must have a unique non-empty role name.`,
          }),
        )
      }
      roleNames.add(issuer.roleName)

      if (!issuer.policyName || policyNames.has(issuer.policyName)) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource,
            message: `PKI issuer "${key}" must have a unique non-empty policy name.`,
          }),
        )
      }
      policyNames.add(issuer.policyName)

      if (
        issuer.allowedDomains.length === 0 ||
        new Set(issuer.allowedDomains).size !== issuer.allowedDomains.length ||
        issuer.allowedDomains.some((domain) => domain.includes("*") || !isDnsName(domain))
      ) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource,
            message: `PKI issuer "${key}" must use a non-empty, unique list of exact lowercase DNS names.`,
          }),
        )
      }

      if (
        !Number.isInteger(issuer.ttlHours) ||
        !Number.isInteger(issuer.maxTtlHours) ||
        issuer.ttlHours <= 0 ||
        issuer.maxTtlHours < issuer.ttlHours ||
        issuer.maxTtlHours > 720
      ) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource,
            message: `PKI issuer "${key}" certificate TTLs must be positive whole hours, ordered, and capped at 30 days.`,
          }),
        )
      }

      const appRole = issuer.appRole
      if (appRole) {
        if (!appRole.backend || appRole.backend.includes("/") || appRole.backend.includes("*")) {
          return yield* Effect.fail(
            new PulumiResourceConfigError({
              resource,
              message: `PKI issuer "${key}" must use a normalized AppRole backend mount name.`,
            }),
          )
        }

        if (!appRole.roleName || appRoleNames.has(appRole.roleName)) {
          return yield* Effect.fail(
            new PulumiResourceConfigError({
              resource,
              message: `PKI issuer "${key}" must have a unique non-empty AppRole name.`,
            }),
          )
        }
        appRoleNames.add(appRole.roleName)

        if (
          appRole.secretIdBoundCidrs.length === 0 ||
          appRole.tokenBoundCidrs.length === 0 ||
          new Set(appRole.secretIdBoundCidrs).size !== appRole.secretIdBoundCidrs.length ||
          new Set(appRole.tokenBoundCidrs).size !== appRole.tokenBoundCidrs.length ||
          !appRole.secretIdBoundCidrs.every(isValidCidr) ||
          !appRole.tokenBoundCidrs.every(isValidCidr) ||
          appRole.secretIdBoundCidrs.some(isBroadCidr) ||
          appRole.tokenBoundCidrs.some(isBroadCidr)
        ) {
          return yield* Effect.fail(
            new PulumiResourceConfigError({
              resource,
              message: `PKI issuer "${key}" AppRole must be bound to explicit, non-global source CIDRs.`,
            }),
          )
        }

        if (
          !isNonNegativeInteger(appRole.secretIdNumUses) ||
          !isNonNegativeInteger(appRole.secretIdTtlSeconds) ||
          !isPositiveInteger(appRole.tokenTtlSeconds) ||
          !isPositiveInteger(appRole.tokenMaxTtlSeconds) ||
          !isPositiveInteger(appRole.tokenExplicitMaxTtlSeconds) ||
          appRole.tokenMaxTtlSeconds < appRole.tokenTtlSeconds ||
          appRole.tokenExplicitMaxTtlSeconds < appRole.tokenMaxTtlSeconds ||
          !isNonNegativeInteger(appRole.tokenNumUses)
        ) {
          return yield* Effect.fail(
            new PulumiResourceConfigError({
              resource,
              message: `PKI issuer "${key}" AppRole has unsafe or internally inconsistent token lifetimes.`,
            }),
          )
        }
      }

      const kubernetesAuthRole = issuer.kubernetesAuthRole
      if (!kubernetesAuthRole) {
        continue
      }

      if (
        !kubernetesAuthRole.backend ||
        kubernetesAuthRole.backend.includes("/") ||
        kubernetesAuthRole.backend.includes("*")
      ) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource,
            message: `PKI issuer "${key}" must use a normalized Kubernetes auth backend mount name.`,
          }),
        )
      }

      if (
        !kubernetesAuthRole.roleName ||
        kubernetesAuthRoleNames.has(kubernetesAuthRole.roleName)
      ) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource,
            message: `PKI issuer "${key}" must have a unique non-empty Kubernetes auth role name.`,
          }),
        )
      }
      kubernetesAuthRoleNames.add(kubernetesAuthRole.roleName)

      if (
        !isUniqueNonEmpty(kubernetesAuthRole.boundServiceAccountNames) ||
        !isUniqueNonEmpty(kubernetesAuthRole.boundServiceAccountNamespaces) ||
        kubernetesAuthRole.boundServiceAccountNames.includes("*") ||
        kubernetesAuthRole.boundServiceAccountNamespaces.includes("*")
      ) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource,
            message: `PKI issuer "${key}" Kubernetes auth must bind exact service accounts and namespaces.`,
          }),
        )
      }

      if (
        !isPositiveInteger(kubernetesAuthRole.tokenTtlSeconds) ||
        !isPositiveInteger(kubernetesAuthRole.tokenMaxTtlSeconds) ||
        !isPositiveInteger(kubernetesAuthRole.tokenExplicitMaxTtlSeconds) ||
        kubernetesAuthRole.tokenMaxTtlSeconds < kubernetesAuthRole.tokenTtlSeconds ||
        kubernetesAuthRole.tokenExplicitMaxTtlSeconds < kubernetesAuthRole.tokenMaxTtlSeconds ||
        kubernetesAuthRole.tokenExplicitMaxTtlSeconds > 3_600
      ) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource,
            message: `PKI issuer "${key}" Kubernetes auth tokens must be ordered and capped at one hour.`,
          }),
        )
      }
    }
  })
}

export function validateExternalSecretsPoliciesEffect(
  policies: Readonly<Record<string, VaultExternalSecretsPolicyConfig>>,
  secretPaths: VaultSecretPathInventory,
): Effect.Effect<void, PulumiResourceConfigError> {
  return Effect.gen(function* () {
    const knownPaths = new Set(Object.values(secretPaths).map((spec) => spec.path))
    const assignedPaths = new Set<string>()
    const policyNames = new Set<string>()

    if (Object.keys(policies).length === 0) {
      return yield* Effect.fail(
        new PulumiResourceConfigError({
          resource: "vault:external-secrets-policies",
          message: "At least one scoped External Secrets policy is required.",
        }),
      )
    }

    for (const [key, policy] of Object.entries(policies)) {
      if (!policy.name || policyNames.has(policy.name)) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource: `vault:external-secrets-policy:${key}`,
            message: `External Secrets policy "${key}" must have a unique non-empty Vault policy name.`,
          }),
        )
      }
      policyNames.add(policy.name)

      if (policy.readPaths.length === 0) {
        return yield* Effect.fail(
          new PulumiResourceConfigError({
            resource: `vault:external-secrets-policy:${key}`,
            message: `External Secrets policy "${key}" must contain at least one exact secret path.`,
          }),
        )
      }

      for (const path of policy.readPaths) {
        if (path.includes("*") || path.includes("+")) {
          return yield* Effect.fail(
            new PulumiResourceConfigError({
              resource: `vault:external-secrets-policy:${key}`,
              message: `External Secrets policy "${key}" cannot use wildcard path "${path}".`,
            }),
          )
        }

        if (!knownPaths.has(path)) {
          return yield* Effect.fail(
            new PulumiResourceConfigError({
              resource: `vault:external-secrets-policy:${key}`,
              message: `External Secrets policy "${key}" references unknown secret path "${path}".`,
            }),
          )
        }

        if (assignedPaths.has(path)) {
          return yield* Effect.fail(
            new PulumiResourceConfigError({
              resource: `vault:external-secrets-policy:${key}`,
              message: `Secret path "${path}" is assigned to more than one External Secrets policy.`,
            }),
          )
        }

        assignedPaths.add(path)
      }
    }
  })
}

export function validateExternalSecretsKubernetesRoleEffect(
  role: VaultKubernetesAuthRoleConfig,
): Effect.Effect<void, PulumiResourceConfigError> {
  return Effect.gen(function* () {
    const resource = "vault:external-secrets-kubernetes-role"

    if (!role.backend || role.backend.includes("/") || role.backend.includes("*")) {
      return yield* Effect.fail(
        new PulumiResourceConfigError({
          resource,
          message: "External Secrets must use a normalized Kubernetes auth backend mount name.",
        }),
      )
    }

    if (!role.roleName || !role.tokenSelfPolicyName) {
      return yield* Effect.fail(
        new PulumiResourceConfigError({
          resource,
          message:
            "External Secrets must use non-empty Kubernetes auth role and token-self policy names.",
        }),
      )
    }

    if (
      !isUniqueNonEmpty(role.boundServiceAccountNames) ||
      !isUniqueNonEmpty(role.boundServiceAccountNamespaces) ||
      role.boundServiceAccountNames.includes("*") ||
      role.boundServiceAccountNamespaces.includes("*")
    ) {
      return yield* Effect.fail(
        new PulumiResourceConfigError({
          resource,
          message:
            "External Secrets Kubernetes auth must bind exact service accounts and namespaces.",
        }),
      )
    }

    if (
      !isPositiveInteger(role.tokenTtlSeconds) ||
      !isPositiveInteger(role.tokenMaxTtlSeconds) ||
      !isPositiveInteger(role.tokenExplicitMaxTtlSeconds) ||
      role.tokenMaxTtlSeconds < role.tokenTtlSeconds ||
      role.tokenExplicitMaxTtlSeconds < role.tokenMaxTtlSeconds ||
      role.tokenExplicitMaxTtlSeconds > 3_600
    ) {
      return yield* Effect.fail(
        new PulumiResourceConfigError({
          resource,
          message:
            "External Secrets Kubernetes auth tokens must be ordered and capped at one hour.",
        }),
      )
    }
  })
}

export function validateExternalSecretsKubernetesAuthBoundaryEffect(
  key: string,
  boundary: VaultExternalSecretsKubernetesAuthBoundaryConfig,
): Effect.Effect<void, PulumiResourceConfigError> {
  return Effect.gen(function* () {
    const resource = `vault:external-secrets-kubernetes-auth-boundary:${key}`

    yield* requireResourceConfigEffect(
      key.trim().length > 0 &&
        isNormalizedMountName(boundary.backend.path) &&
        boundary.backend.path === boundary.role.backend,
      resource,
      "Kubernetes auth boundary keys and backend paths must be normalized, and the role must use the boundary backend.",
    )
    yield* requireResourceConfigEffect(
      boundary.backend.description.trim().length > 0 &&
        isHttpsUrl(boundary.backend.kubernetesHost) &&
        boundary.backend.kubernetesCaCert.includes("-----BEGIN CERTIFICATE-----") &&
        boundary.backend.kubernetesCaCert.includes("-----END CERTIFICATE-----") &&
        boundary.backend.disableLocalCaJwt,
      resource,
      "Kubernetes auth boundaries require an HTTPS API endpoint, PEM CA certificate, description, and disabled local CA/JWT discovery.",
    )
    yield* requireResourceConfigEffect(
      Object.keys(boundary.policies).length > 0,
      resource,
      "Kubernetes auth boundaries require at least one exact External Secrets policy.",
    )
    yield* requireResourceConfigEffect(
      Object.values(boundary.resourceNames).every((name) => name.trim().length > 0) &&
        new Set(Object.values(boundary.resourceNames)).size ===
          Object.values(boundary.resourceNames).length,
      resource,
      "Kubernetes auth boundary resource names must be non-empty and unique.",
    )
    yield* validateExternalSecretsKubernetesRoleEffect(boundary.role)
  })
}

function humanAdminPolicy(kvMountPath: string) {
  return [
    policyRule(`${kvMountPath}/*`, ["create", "read", "update", "delete", "list", "sudo"]),
    policyRule("sys/mounts", ["read", "list"]),
    policyRule("sys/mounts/*", ["create", "read", "update", "delete", "list", "sudo"]),
    policyRule("sys/auth", ["read", "list"]),
    policyRule("sys/auth/*", ["create", "read", "update", "delete", "list", "sudo"]),
    policyRule("sys/audit", ["read", "list", "sudo"]),
    policyRule("sys/audit/*", ["create", "read", "update", "delete", "list", "sudo"]),
    policyRule("sys/policies/acl", ["read", "list"]),
    policyRule("sys/policies/acl/*", ["create", "read", "update", "delete", "list"]),
    policyRule("auth/token/create", ["create", "update", "sudo"]),
    policyRule("auth/token/lookup", ["update"]),
    policyRule("auth/token/lookup-self", ["read"]),
    policyRule("auth/token/renew-self", ["update"]),
    policyRule("auth/token/revoke-self", ["update"]),
  ].join("\n\n")
}

function secretPathOutputEffect(
  mountPath: string,
  spec: VaultSecretPathSpec,
): Effect.Effect<VaultSecretPathOutput, PulumiResourceConfigError> {
  const fullPath = `${mountPath}/${spec.path}`

  return relativeKvPathEffect(mountPath, fullPath).pipe(
    Effect.map((relativePath) => ({
      path: fullPath,
      kvV2DataPath: `${mountPath}/data/${relativePath}`,
      fields: spec.fields,
      description: spec.description,
    })),
  )
}

export type PlannedExternalSecretsPolicy = {
  readonly key: string
  readonly policy: VaultExternalSecretsPolicyConfig
  readonly resourceName: string
}

export type PlannedExternalSecretsKubernetesAuthBoundary = {
  readonly key: string
  readonly boundary: VaultExternalSecretsKubernetesAuthBoundaryConfig
  readonly policyEntries: ReadonlyArray<PlannedExternalSecretsPolicy>
}

export type PlannedPkiIssuer = {
  readonly key: string
  readonly issuer: VaultPkiIssuerConfig
  readonly resourceNames: {
    readonly role: string
    readonly policy: string
    readonly appRole: string
    readonly kubernetesAuthRole: string
  }
}

export type VaultFoundationPlan = {
  readonly resourceNames: VaultFoundationResourceNames
  readonly externalSecretsPolicyEntries: ReadonlyArray<PlannedExternalSecretsPolicy>
  readonly externalSecretsKubernetesAuthBoundaryEntries: ReadonlyArray<PlannedExternalSecretsKubernetesAuthBoundary>
  readonly pkiIssuerEntries: ReadonlyArray<PlannedPkiIssuer>
  readonly secretPathEntries: ReadonlyArray<readonly [string, VaultSecretPathOutput]>
}

const isNormalizedMountName = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)

const isNormalizedSecretPath = (value: string) =>
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.endsWith("/") &&
  !value.includes("*") &&
  !value.includes("+") &&
  value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        /^[a-zA-Z0-9._-]+$/.test(segment),
    )

export const planVaultFoundationEffect = Effect.fn("Vault.planFoundation")(function* (
  args: VaultFoundationArgs,
) {
  yield* validateExternalSecretsKubernetesRoleEffect(args.externalSecretsKubernetesRole)
  const externalSecretsKubernetesAuthBoundaryEntries = Object.entries(
    args.externalSecretsKubernetesAuthBoundaries ?? {},
  ).map(([key, boundary]) => ({
    key,
    boundary,
    policyEntries: Object.entries(boundary.policies).map(([policyKey, policy]) => ({
      key: policyKey,
      policy,
      resourceName: policy.resourceName ?? `external-secrets-policy-${key}-${policyKey}`,
    })),
  }))
  for (const { key, boundary } of externalSecretsKubernetesAuthBoundaryEntries) {
    yield* validateExternalSecretsKubernetesAuthBoundaryEffect(key, boundary)
  }
  yield* validateExternalSecretsPoliciesEffect(
    Object.fromEntries([
      ...Object.entries(args.externalSecretsPolicies),
      ...externalSecretsKubernetesAuthBoundaryEntries.flatMap(({ key, boundary }) =>
        Object.entries(boundary.policies).map(([policyKey, policy]) => [
          `${key}:${policyKey}`,
          policy,
        ]),
      ),
    ]),
    args.secretPaths,
  )
  if (args.raftSnapshotAppRole) {
    yield* validateRaftSnapshotAppRoleEffect(args.raftSnapshotAppRole)
  }
  yield* validatePkiIssuerInventoryEffect(args.pkiIssuers)

  yield* requireResourceConfigEffect(
    isNormalizedMountName(args.kv.path),
    "vault:kv",
    "KV mount path must be a normalized mount name without slashes or wildcards.",
  )
  yield* requireResourceConfigEffect(
    args.kv.description.trim().length > 0 && isPositiveInteger(args.kv.maxVersions),
    "vault:kv",
    "KV description must be non-empty and maxVersions must be a positive integer.",
  )
  yield* requireResourceConfigEffect(
    args.humanAdminPolicy.name.trim().length > 0,
    "vault:humanAdminPolicy",
    "Human administrator policy name must not be empty.",
  )
  yield* requireResourceConfigEffect(
    !args.audit.enabled ||
      (args.audit.path.trim().length > 0 &&
        args.audit.description.trim().length > 0 &&
        Object.keys(args.audit.options).length > 0 &&
        Object.entries(args.audit.options).every(
          ([key, value]) => key.trim().length > 0 && value.trim().length > 0,
        )),
    "vault:audit",
    "Enabled audit devices require non-empty path, description, and options.",
  )

  const resourceNames = args.resourceNames
  const externalSecretsPolicyEntries = Object.entries(args.externalSecretsPolicies).map(
    ([key, policy]) => ({
      key,
      policy,
      resourceName: policy.resourceName ?? `external-secrets-policy-${key}`,
    }),
  )
  const pkiIssuerEntries = Object.entries(args.pkiIssuers).map(([key, issuer]) => ({
    key,
    issuer,
    resourceNames: {
      role: issuer.resourceNames?.role ?? `pki-issuer-role-${key}`,
      policy: issuer.resourceNames?.policy ?? `pki-issuer-policy-${key}`,
      appRole: issuer.resourceNames?.appRole ?? `pki-issuer-approle-${key}`,
      kubernetesAuthRole:
        issuer.resourceNames?.kubernetesAuthRole ?? `pki-issuer-kubernetes-role-${key}`,
    },
  }))

  const logicalResourceNames = [
    ...Object.values(resourceNames),
    ...externalSecretsPolicyEntries.map(({ resourceName }) => resourceName),
    ...externalSecretsKubernetesAuthBoundaryEntries.flatMap(({ boundary, policyEntries }) => [
      ...Object.values(boundary.resourceNames),
      ...policyEntries.map(({ resourceName }) => resourceName),
    ]),
    ...pkiIssuerEntries.flatMap(({ issuer, resourceNames: names }) => [
      names.role,
      names.policy,
      ...(issuer.appRole ? [names.appRole] : []),
      ...(issuer.kubernetesAuthRole ? [names.kubernetesAuthRole] : []),
    ]),
  ]
  yield* requireResourceConfigEffect(
    logicalResourceNames.every((name) => name.trim().length > 0) &&
      new Set(logicalResourceNames).size === logicalResourceNames.length,
    "vault:resourceNames",
    "Generated Pulumi logical resource names must be non-empty and unique.",
  )

  const physicalPolicyNames = [
    args.humanAdminPolicy.name,
    args.externalSecretsKubernetesRole.tokenSelfPolicyName,
    ...externalSecretsKubernetesAuthBoundaryEntries.flatMap(({ boundary, policyEntries }) => [
      boundary.role.tokenSelfPolicyName,
      ...policyEntries.map(({ policy }) => policy.name),
    ]),
    ...(args.raftSnapshotAppRole ? [args.raftSnapshotAppRole.policyName] : []),
    ...externalSecretsPolicyEntries.map(({ policy }) => policy.name),
    ...pkiIssuerEntries.map(({ issuer }) => issuer.policyName),
  ]
  yield* requireResourceConfigEffect(
    physicalPolicyNames.every((name) => name.trim().length > 0) &&
      new Set(physicalPolicyNames).size === physicalPolicyNames.length,
    "vault:policies",
    "Physical Vault policy names must be non-empty and unique across the complete foundation.",
  )

  const kubernetesAuthRoleIdentities = [
    `${args.externalSecretsKubernetesRole.backend}\0${args.externalSecretsKubernetesRole.roleName}`,
    ...externalSecretsKubernetesAuthBoundaryEntries.map(
      ({ boundary }) => `${boundary.role.backend}\0${boundary.role.roleName}`,
    ),
    ...pkiIssuerEntries.flatMap(({ issuer }) =>
      issuer.kubernetesAuthRole
        ? [`${issuer.kubernetesAuthRole.backend}\0${issuer.kubernetesAuthRole.roleName}`]
        : [],
    ),
  ]
  yield* requireResourceConfigEffect(
    new Set(kubernetesAuthRoleIdentities).size === kubernetesAuthRoleIdentities.length,
    "vault:kubernetesAuthRoles",
    "Physical Vault Kubernetes auth roles must have unique backend and role-name identities.",
  )

  const existingKubernetesAuthBackends = new Set([args.externalSecretsKubernetesRole.backend])
  const managedKubernetesAuthBackends = externalSecretsKubernetesAuthBoundaryEntries.map(
    ({ boundary }) => boundary.backend.path,
  )
  yield* requireResourceConfigEffect(
    new Set(managedKubernetesAuthBackends).size === managedKubernetesAuthBackends.length &&
      managedKubernetesAuthBackends.every(
        (backend) => !existingKubernetesAuthBackends.has(backend),
      ),
    "vault:kubernetesAuthBackends",
    "Managed Kubernetes auth backend paths must be unique and must not replace externally managed backends.",
  )
  const availableKubernetesAuthBackends = new Set([
    ...existingKubernetesAuthBackends,
    ...managedKubernetesAuthBackends,
  ])
  yield* requireResourceConfigEffect(
    pkiIssuerEntries.every(
      ({ issuer }) =>
        !issuer.kubernetesAuthRole ||
        availableKubernetesAuthBackends.has(issuer.kubernetesAuthRole.backend),
    ),
    "vault:kubernetesAuthBackends",
    "PKI Kubernetes auth roles must reference a declared external or managed Kubernetes auth backend.",
  )

  const secretPaths = Object.values(args.secretPaths).map(({ path }) => path)
  yield* requireResourceConfigEffect(
    Object.keys(args.secretPaths).every((key) => key.trim().length > 0) &&
      new Set(secretPaths).size === secretPaths.length,
    "vault:secretPaths",
    "Secret inventory keys and paths must be non-empty and unique.",
  )
  const secretPathEntries = yield* Effect.forEach(Object.entries(args.secretPaths), ([key, spec]) =>
    Effect.gen(function* () {
      yield* requireResourceConfigEffect(
        isNormalizedSecretPath(spec.path),
        `vault:secretPath:${key}`,
        `Secret path "${spec.path}" must be relative, normalized, and free of wildcards.`,
      )
      yield* requireResourceConfigEffect(
        spec.description.trim().length > 0 && isUniqueNonEmpty(spec.fields),
        `vault:secretPath:${key}`,
        `Secret path "${spec.path}" requires a description and unique non-empty fields.`,
      )
      return yield* secretPathOutputEffect(args.kv.path, spec).pipe(
        Effect.map((secretPath) => [key, secretPath] as const),
      )
    }),
  )

  return {
    resourceNames,
    externalSecretsPolicyEntries,
    externalSecretsKubernetesAuthBoundaryEntries,
    pkiIssuerEntries,
    secretPathEntries,
  } satisfies VaultFoundationPlan
})

export const createVaultFoundationEffect = Effect.fn("Vault.createFoundation")(function* (
  args: VaultFoundationArgs,
) {
  const plan = yield* planVaultFoundationEffect(args)
  const {
    externalSecretsPolicyEntries,
    externalSecretsKubernetesAuthBoundaryEntries,
    pkiIssuerEntries,
    resourceNames,
    secretPathEntries,
  } = plan
  const provider = yield* registerPulumiResource(
    resourceNames.provider,
    () =>
      new vault.Provider(
        resourceNames.provider,
        {
          address: args.connection.address,
          token: pulumi.secret(args.connection.token),
          ...(args.connection.caCertFile ? { caCertFile: args.connection.caCertFile } : undefined),
          ...(args.connection.skipTlsVerify
            ? { skipTlsVerify: args.connection.skipTlsVerify }
            : undefined),
        },
        args.providerOptions,
      ),
  )
  const resourceOptions: pulumi.CustomResourceOptions = {
    ...args.resourceOptions,
    provider,
  }
  const protectedPkiResourceOptions: pulumi.CustomResourceOptions = {
    ...args.resourceOptions,
    provider,
    protect: true,
  }

  const kvMount = yield* registerPulumiResource(
    resourceNames.kvMount,
    () =>
      new vault.Mount(
        resourceNames.kvMount,
        {
          path: args.kv.path,
          type: "kv",
          description: args.kv.description,
          options: {
            version: "2",
          },
        },
        resourceOptions,
      ),
  )

  const kvConfig = yield* registerPulumiResource(
    resourceNames.kvConfig,
    () =>
      new vault.kv.SecretBackendV2(
        resourceNames.kvConfig,
        {
          mount: kvMount.path,
          maxVersions: args.kv.maxVersions,
          casRequired: args.kv.casRequired,
        },
        { ...resourceOptions, dependsOn: [kvMount] },
      ),
  )

  const adminPolicy = yield* registerPulumiResource(
    resourceNames.humanAdminPolicy,
    () =>
      new vault.Policy(
        resourceNames.humanAdminPolicy,
        {
          name: args.humanAdminPolicy.name,
          policy: humanAdminPolicy(args.kv.path),
        },
        { ...resourceOptions, dependsOn: [kvMount] },
      ),
  )

  const externalSecretsPolicies = Object.fromEntries(
    yield* Effect.forEach(externalSecretsPolicyEntries, ({ key, policy, resourceName }) =>
      registerPulumiResource(
        resourceName,
        () =>
          new vault.Policy(
            resourceName,
            {
              name: policy.name,
              policy: renderKvV2ReadPolicy(args.kv.path, policy.readPaths),
            },
            { ...resourceOptions, dependsOn: [kvMount] },
          ),
      ).pipe(Effect.map((resource) => [key, resource.name] as const)),
    ),
  )

  const externalSecretsTokenSelfPolicy = yield* registerPulumiResource(
    resourceNames.externalSecretsTokenSelfPolicy,
    () =>
      new vault.Policy(
        resourceNames.externalSecretsTokenSelfPolicy,
        {
          name: args.externalSecretsKubernetesRole.tokenSelfPolicyName,
          policy: renderTokenSelfPolicy(),
        },
        { ...resourceOptions, protect: true },
      ),
  )

  const externalSecretsKubernetesRole = yield* registerPulumiResource(
    resourceNames.externalSecretsKubernetesRole,
    () =>
      new vault.kubernetes.AuthBackendRole(
        resourceNames.externalSecretsKubernetesRole,
        {
          backend: args.externalSecretsKubernetesRole.backend,
          roleName: args.externalSecretsKubernetesRole.roleName,
          boundServiceAccountNames: [
            ...args.externalSecretsKubernetesRole.boundServiceAccountNames,
          ],
          boundServiceAccountNamespaces: [
            ...args.externalSecretsKubernetesRole.boundServiceAccountNamespaces,
          ],
          tokenExplicitMaxTtl: args.externalSecretsKubernetesRole.tokenExplicitMaxTtlSeconds,
          tokenMaxTtl: args.externalSecretsKubernetesRole.tokenMaxTtlSeconds,
          tokenNoDefaultPolicy: true,
          tokenNumUses: 0,
          tokenPolicies: [
            ...Object.values(externalSecretsPolicies),
            externalSecretsTokenSelfPolicy.name,
          ],
          tokenTtl: args.externalSecretsKubernetesRole.tokenTtlSeconds,
          tokenType: "service",
        },
        {
          ...resourceOptions,
          protect: true,
        },
      ),
  )

  const externalSecretsKubernetesAuthBoundaries = Object.fromEntries(
    yield* Effect.forEach(
      externalSecretsKubernetesAuthBoundaryEntries,
      ({ key, boundary, policyEntries }) =>
        Effect.gen(function* () {
          const authBackend = yield* registerPulumiResource(
            boundary.resourceNames.authBackend,
            () =>
              new vault.AuthBackend(
                boundary.resourceNames.authBackend,
                {
                  type: "kubernetes",
                  path: boundary.backend.path,
                  description: boundary.backend.description,
                },
                { ...resourceOptions, protect: true },
              ),
          )
          const authBackendConfig = yield* registerPulumiResource(
            boundary.resourceNames.authBackendConfig,
            () =>
              new vault.kubernetes.AuthBackendConfig(
                boundary.resourceNames.authBackendConfig,
                {
                  backend: authBackend.path,
                  kubernetesHost: boundary.backend.kubernetesHost,
                  kubernetesCaCert: boundary.backend.kubernetesCaCert,
                  disableLocalCaJwt: boundary.backend.disableLocalCaJwt,
                },
                { ...resourceOptions, dependsOn: [authBackend], protect: true },
              ),
          )
          const policies = Object.fromEntries(
            yield* Effect.forEach(policyEntries, ({ key: policyKey, policy, resourceName }) =>
              registerPulumiResource(
                resourceName,
                () =>
                  new vault.Policy(
                    resourceName,
                    {
                      name: policy.name,
                      policy: renderKvV2ReadPolicy(args.kv.path, policy.readPaths),
                    },
                    { ...resourceOptions, dependsOn: [kvMount] },
                  ),
              ).pipe(Effect.map((resource) => [policyKey, resource] as const)),
            ),
          )
          const tokenSelfPolicy = yield* registerPulumiResource(
            boundary.resourceNames.tokenSelfPolicy,
            () =>
              new vault.Policy(
                boundary.resourceNames.tokenSelfPolicy,
                {
                  name: boundary.role.tokenSelfPolicyName,
                  policy: renderTokenSelfPolicy(),
                },
                { ...resourceOptions, protect: true },
              ),
          )
          const role = yield* registerPulumiResource(
            boundary.resourceNames.kubernetesRole,
            () =>
              new vault.kubernetes.AuthBackendRole(
                boundary.resourceNames.kubernetesRole,
                {
                  backend: authBackend.path,
                  roleName: boundary.role.roleName,
                  boundServiceAccountNames: [...boundary.role.boundServiceAccountNames],
                  boundServiceAccountNamespaces: [...boundary.role.boundServiceAccountNamespaces],
                  tokenExplicitMaxTtl: boundary.role.tokenExplicitMaxTtlSeconds,
                  tokenMaxTtl: boundary.role.tokenMaxTtlSeconds,
                  tokenNoDefaultPolicy: true,
                  tokenNumUses: 0,
                  tokenPolicies: [
                    ...Object.values(policies).map((policy) => policy.name),
                    tokenSelfPolicy.name,
                  ],
                  tokenTtl: boundary.role.tokenTtlSeconds,
                  tokenType: "service",
                },
                {
                  ...resourceOptions,
                  dependsOn: [authBackendConfig, ...Object.values(policies), tokenSelfPolicy],
                  protect: true,
                },
              ),
          )

          return [
            key,
            {
              backend: authBackend.path,
              config: authBackendConfig.id,
              roleName: role.roleName,
              policies: role.tokenPolicies,
            },
          ] as const
        }),
    ),
  )

  const raftSnapshotPolicy = args.raftSnapshotAppRole
    ? yield* registerPulumiResource(
        "raft-snapshot-policy",
        () =>
          new vault.Policy(
            "raft-snapshot-policy",
            {
              name: args.raftSnapshotAppRole!.policyName,
              policy: renderRaftSnapshotPolicy(),
            },
            { ...resourceOptions, protect: true },
          ),
      )
    : undefined

  const raftSnapshotAppRole =
    args.raftSnapshotAppRole && raftSnapshotPolicy
      ? yield* registerPulumiResource(
          "raft-snapshot-approle",
          () =>
            new vault.approle.AuthBackendRole(
              "raft-snapshot-approle",
              {
                backend: args.raftSnapshotAppRole!.backend,
                roleName: args.raftSnapshotAppRole!.roleName,
                roleId: args.raftSnapshotAppRole!.roleId,
                bindSecretId: true,
                localSecretIds: false,
                secretIdBoundCidrs: [...args.raftSnapshotAppRole!.secretIdBoundCidrs],
                secretIdNumUses: 0,
                secretIdTtl: 0,
                tokenBoundCidrs: [...args.raftSnapshotAppRole!.tokenBoundCidrs],
                tokenExplicitMaxTtl: args.raftSnapshotAppRole!.tokenExplicitMaxTtlSeconds,
                tokenMaxTtl: args.raftSnapshotAppRole!.tokenMaxTtlSeconds,
                tokenNoDefaultPolicy: true,
                tokenNumUses: 0,
                tokenPolicies: [raftSnapshotPolicy.name],
                tokenTtl: args.raftSnapshotAppRole!.tokenTtlSeconds,
                tokenType: "service",
              },
              { ...resourceOptions, protect: true, dependsOn: [raftSnapshotPolicy] },
            ),
        )
      : undefined

  const pkiIssuers = Object.fromEntries(
    yield* Effect.forEach(pkiIssuerEntries, ({ key, issuer, resourceNames: issuerResourceNames }) =>
      Effect.gen(function* () {
        const role = yield* registerPulumiResource(
          issuerResourceNames.role,
          () =>
            new vault.pkisecret.SecretBackendRole(
              issuerResourceNames.role,
              {
                backend: issuer.backend,
                name: issuer.roleName,
                allowedDomains: [...issuer.allowedDomains],
                allowAnyName: false,
                allowBareDomains: true,
                allowGlobDomains: false,
                allowIpSans: false,
                allowLocalhost: false,
                allowSubdomains: false,
                allowWildcardCertificates: issuer.allowWildcardCertificates,
                allowedDomainsTemplate: false,
                clientFlag: false,
                cnValidations: ["hostname"],
                codeSigningFlag: false,
                emailProtectionFlag: false,
                enforceHostnames: true,
                extKeyUsages: ["ServerAuth"],
                generateLease: issuer.generateLease,
                issuerRef: "default",
                keyBits: 2_048,
                keyType: "rsa",
                keyUsages: ["DigitalSignature", "KeyEncipherment"],
                maxTtl: `${issuer.maxTtlHours * 60 * 60}`,
                noStore: false,
                noStoreMetadata: false,
                notBeforeDuration: "30s",
                requireCn: true,
                serverFlag: true,
                ttl: `${issuer.ttlHours * 60 * 60}`,
              },
              protectedPkiResourceOptions,
            ),
        )

        const policy = yield* registerPulumiResource(
          issuerResourceNames.policy,
          () =>
            new vault.Policy(
              issuerResourceNames.policy,
              {
                name: issuer.policyName,
                policy: renderPkiIssuePolicy(issuer.backend, issuer.roleName),
              },
              { ...protectedPkiResourceOptions, dependsOn: [role] },
            ),
        )

        const appRole = issuer.appRole
          ? yield* registerPulumiResource(
              issuerResourceNames.appRole,
              () =>
                new vault.approle.AuthBackendRole(
                  issuerResourceNames.appRole,
                  {
                    backend: issuer.appRole!.backend,
                    roleName: issuer.appRole!.roleName,
                    roleId: issuer.appRole!.roleId,
                    bindSecretId: true,
                    localSecretIds: false,
                    secretIdBoundCidrs: [...issuer.appRole!.secretIdBoundCidrs],
                    secretIdNumUses: issuer.appRole!.secretIdNumUses,
                    secretIdTtl: issuer.appRole!.secretIdTtlSeconds,
                    tokenBoundCidrs: [...issuer.appRole!.tokenBoundCidrs],
                    tokenExplicitMaxTtl: issuer.appRole!.tokenExplicitMaxTtlSeconds,
                    tokenMaxTtl: issuer.appRole!.tokenMaxTtlSeconds,
                    tokenNoDefaultPolicy: true,
                    tokenNumUses: issuer.appRole!.tokenNumUses,
                    tokenPolicies: [policy.name],
                    tokenTtl: issuer.appRole!.tokenTtlSeconds,
                    tokenType: "batch",
                  },
                  { ...protectedPkiResourceOptions, dependsOn: [role, policy] },
                ),
            )
          : undefined

        const kubernetesAuthRole = issuer.kubernetesAuthRole
          ? yield* registerPulumiResource(
              issuerResourceNames.kubernetesAuthRole,
              () => {
                const managedBoundary = externalSecretsKubernetesAuthBoundaryEntries.find(
                  ({ boundary }) => boundary.backend.path === issuer.kubernetesAuthRole!.backend,
                )
                const backend = managedBoundary
                  ? externalSecretsKubernetesAuthBoundaries[managedBoundary.key]!.backend
                  : issuer.kubernetesAuthRole!.backend

                return new vault.kubernetes.AuthBackendRole(
                  issuerResourceNames.kubernetesAuthRole,
                  {
                    backend,
                    roleName: issuer.kubernetesAuthRole!.roleName,
                    boundServiceAccountNames: [
                      ...issuer.kubernetesAuthRole!.boundServiceAccountNames,
                    ],
                    boundServiceAccountNamespaces: [
                      ...issuer.kubernetesAuthRole!.boundServiceAccountNamespaces,
                    ],
                    tokenExplicitMaxTtl: issuer.kubernetesAuthRole!.tokenExplicitMaxTtlSeconds,
                    tokenMaxTtl: issuer.kubernetesAuthRole!.tokenMaxTtlSeconds,
                    tokenNoDefaultPolicy: true,
                    tokenNumUses: 0,
                    tokenPolicies: [policy.name, externalSecretsTokenSelfPolicy.name],
                    tokenTtl: issuer.kubernetesAuthRole!.tokenTtlSeconds,
                    tokenType: "service",
                  },
                  {
                    ...protectedPkiResourceOptions,
                    dependsOn: [role, policy, externalSecretsTokenSelfPolicy],
                  },
                )
              },
            )
          : undefined

        return [
          key,
          {
            backend: role.backend,
            roleName: role.name,
            policyName: policy.name,
            appRole: appRole
              ? {
                  backend: appRole.backend,
                  roleName: appRole.roleName,
                  roleId: appRole.roleId,
                }
              : undefined,
            kubernetesAuthRole: kubernetesAuthRole
              ? {
                  backend: kubernetesAuthRole.backend,
                  roleName: kubernetesAuthRole.roleName,
                  policies: kubernetesAuthRole.tokenPolicies,
                }
              : undefined,
          },
        ] as const
      }),
    ),
  )

  const audit = args.audit.enabled
    ? yield* registerPulumiResource(
        resourceNames.audit,
        () =>
          new vault.Audit(
            resourceNames.audit,
            {
              type: args.audit.type,
              path: args.audit.path,
              description: args.audit.description,
              options: args.audit.options,
            },
            resourceOptions,
          ),
      )
    : undefined

  return {
    mounts: {
      kv: {
        path: kvMount.path,
        config: kvConfig.id,
      },
    },
    policies: {
      humanAdmin: adminPolicy.name,
      externalSecrets: externalSecretsPolicies,
      externalSecretsTokenSelf: externalSecretsTokenSelfPolicy.name,
      raftSnapshot: raftSnapshotPolicy?.name,
      pkiIssuers: Object.fromEntries(
        Object.entries(pkiIssuers).map(([key, issuer]) => [key, issuer.policyName]),
      ),
    },
    externalSecretsKubernetesRole: {
      backend: externalSecretsKubernetesRole.backend,
      roleName: externalSecretsKubernetesRole.roleName,
      policies: externalSecretsKubernetesRole.tokenPolicies,
    },
    externalSecretsKubernetesAuthBoundaries,
    raftSnapshotAppRole: {
      backend: raftSnapshotAppRole?.backend,
      roleName: raftSnapshotAppRole?.roleName,
      roleId: raftSnapshotAppRole?.roleId,
      policies: raftSnapshotAppRole?.tokenPolicies,
    },
    pkiIssuers,
    audit: {
      path: audit?.path,
      type: audit?.type,
    },
    secretPaths: Object.fromEntries(secretPathEntries),
  }
})
