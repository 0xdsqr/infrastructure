import { FileSystem, Path } from "@effect/platform"
import { Console, Effect, Either } from "effect"
import { stringify } from "yaml"

import { generateGitOps } from "./generate.ts"
import { GitOpsUsageError, type GitOpsValidationError } from "./errors.ts"
import { renderGitOps } from "./render.ts"
import {
  asArray,
  asRecord,
  asString,
  field,
  isRecord,
  listDirectories,
  listFilesRecursive,
  mapFileSystemError,
  nestedRecord,
  nestedValue,
  parseYamlDocuments,
  pathExists,
  readText,
  readYamlRecord,
  renderKustomization,
  requirePathType,
  resolveDirectory,
  snapshotDirectory,
  validate,
  writeText,
  type YamlRecord,
} from "./runtime.ts"

const resourceFilePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.yaml$/
const resourceFinalizer = "resources-finalizer.argocd.argoproj.io"
const obsoleteGitOpsPattern =
  /gitops\/manifests|CreateNamespace=true|managedNamespaceMetadata|targetRevision: master/
const obsoleteApplicationPattern = /CreateNamespace=true|managedNamespaceMetadata|homelab\.dev\//
const immutableGitCommitPattern = /^[0-9a-f]{40}$/i

const stringAt = (record: YamlRecord | undefined, ...path: readonly string[]) =>
  asString(nestedValue(record, ...path))

const arrayAt = (record: YamlRecord | undefined, ...path: readonly string[]) =>
  asArray(nestedValue(record, ...path)) ?? []

export const isSupportedSourceTransport = (source: YamlRecord): boolean => {
  if (stringAt(source, "repoURL")?.startsWith("https://") === true) return true
  if (stringAt(source, "repoURL") === "ghcr.io/argoproj/argo-helm") {
    return stringAt(source, "chart") === "argo-cd" && /^\d+\.\d+\.\d+$/.test(stringAt(source, "targetRevision") ?? "")
  }
  // Argo's Helm OCI sources omit the URL scheme. Keep this exception scoped
  // to the pinned official Envoy charts; it does not allow arbitrary HTTP.
  return (
    stringAt(source, "repoURL") === "docker.io/envoyproxy" &&
    ["gateway-crds-helm", "gateway-helm"].includes(stringAt(source, "chart") ?? "") &&
    /^v\d+\.\d+\.\d+$/.test(stringAt(source, "targetRevision") ?? "")
  )
}

const sourcesOf = (application: YamlRecord): readonly YamlRecord[] => {
  const sources = asArray(nestedValue(application, "spec", "sources"))
  if (sources) {
    return sources.filter(isRecord)
  }

  const source = asRecord(nestedValue(application, "spec", "source"))
  return source ? [source] : []
}

const validateAppProject = Effect.fn("GitOps.validateAppProject")(function* (
  projectFile: string,
  project: YamlRecord,
) {
  const projectName = stringAt(project, "metadata", "name")
  yield* validate(
    projectName !== undefined && projectName.length > 0,
    `${projectFile} has no project name`,
    projectFile,
  )

  if (projectName === "default") {
    yield* validate(
      arrayAt(project, "spec", "sourceRepos").length === 0 &&
        arrayAt(project, "spec", "destinations").length === 0,
      `${projectFile} does not deny all sources and destinations`,
      projectFile,
    )
    return projectName
  }

  const finalizers = arrayAt(project, "metadata", "finalizers")
  yield* validate(
    field(project, "apiVersion") === "argoproj.io/v1alpha1" &&
      field(project, "kind") === "AppProject" &&
      finalizers.filter((finalizer) => finalizer === resourceFinalizer).length === 1,
    `${projectFile} lacks the Argo CD resource finalizer`,
    projectFile,
  )

  yield* validate(
    !arrayAt(project, "spec", "sourceRepos").includes("*"),
    `${projectFile} permits a wildcard source repository`,
    projectFile,
  )

  for (const destinationValue of arrayAt(project, "spec", "destinations")) {
    const destination = asRecord(destinationValue)
    yield* validate(
      field(destination, "server") !== "*" && field(destination, "namespace") !== "*",
      `${projectFile} permits a wildcard destination`,
      projectFile,
    )
  }

  for (const permissionValue of arrayAt(project, "spec", "clusterResourceWhitelist")) {
    const permission = asRecord(permissionValue)
    if (!permission) {
      continue
    }
    const group = field(permission, "group")
    const kind = field(permission, "kind")
    const name = field(permission, "name")
    yield* validate(
      group !== "*" && kind !== "*" && typeof name === "string" && name.length > 0 && name !== "*",
      `${projectFile} has an unnamed or wildcard cluster permission`,
      projectFile,
    )
  }

  for (const permissionValue of arrayAt(project, "spec", "namespaceResourceWhitelist")) {
    const permission = asRecord(permissionValue)
    if (!permission) {
      continue
    }
    yield* validate(
      field(permission, "group") !== "*" && field(permission, "kind") !== "*",
      `${projectFile} has a wildcard namespace permission`,
      projectFile,
    )
  }

  return projectName!
})

type RootApplication = {
  readonly namespace: string
  readonly repositoryUrl: string
  readonly server: string
}

const validateRootApplication = Effect.fn("GitOps.validateRootApplication")(function* (
  cluster: string,
  rootApplicationPath: string,
) {
  const root = yield* readYamlRecord(rootApplicationPath)
  const namespace = stringAt(root, "metadata", "namespace")
  const repositoryUrl = stringAt(root, "spec", "source", "repoURL")
  const server = stringAt(root, "spec", "destination", "server")
  const expectedPath = `gitops/clusters/${cluster}/applications`

  yield* validate(
    field(root, "apiVersion") === "argoproj.io/v1alpha1" &&
      field(root, "kind") === "Application" &&
      stringAt(root, "metadata", "name") === cluster &&
      namespace !== undefined &&
      namespace === stringAt(root, "spec", "destination", "namespace") &&
      stringAt(root, "spec", "project") === "bootstrap" &&
      stringAt(root, "spec", "source", "path") === expectedPath &&
      stringAt(root, "spec", "source", "targetRevision") === "refs/heads/master" &&
      repositoryUrl?.startsWith("https://") === true &&
      server?.startsWith("https://") === true &&
      nestedValue(root, "spec", "syncPolicy", "automated", "enabled") === true &&
      nestedValue(root, "spec", "syncPolicy", "automated", "prune") === true &&
      nestedValue(root, "metadata", "finalizers") == null,
    `${cluster} bootstrap Application policy is invalid`,
    rootApplicationPath,
  )

  return {
    namespace: namespace!,
    repositoryUrl: repositoryUrl!,
    server: server!,
  } satisfies RootApplication
})

const validateBootstrapProject = Effect.fn("GitOps.validateBootstrapProject")(function* (
  cluster: string,
  bootstrapProjectPath: string,
  root: RootApplication,
) {
  const project = yield* readYamlRecord(bootstrapProjectPath)
  const sourceRepositories = arrayAt(project, "spec", "sourceRepos")
  const destinations = arrayAt(project, "spec", "destinations")

  yield* validate(
    stringAt(project, "metadata", "name") === "bootstrap" && sourceRepositories.length === 1,
    `${cluster} bootstrap AppProject is invalid`,
    bootstrapProjectPath,
  )
  yield* validate(
    sourceRepositories[0] === root.repositoryUrl &&
      destinations.every(
        (destination) => stringAt(asRecord(destination), "server") === root.server,
      ),
    `${cluster} bootstrap AppProject does not match its root Application`,
    bootstrapProjectPath,
  )
})

const validateNamespace = (
  applicationName: string,
  namespace: YamlRecord,
): Effect.Effect<void, GitOpsValidationError> => {
  const annotations = nestedRecord(namespace, "metadata", "annotations")
  const labels = nestedRecord(namespace, "metadata", "labels")
  const syncOptions = stringAt(annotations, "argocd.argoproj.io/sync-options") ?? ""
  return validate(
    stringAt(annotations, "argocd.argoproj.io/sync-wave") === "0" &&
      syncOptions.includes("ServerSideApply=true") &&
      syncOptions.includes("Prune=confirm") &&
      syncOptions.includes("Delete=confirm") &&
      stringAt(labels, "app.kubernetes.io/managed-by") === "argocd",
    `${applicationName} renders unprotected Namespaces: ${stringAt(namespace, "metadata", "name") ?? "<unnamed>"}`,
  )
}

export const resolveLocalGitOpsSourcePath = Effect.fn("GitOps.resolveLocalSource")(function* (
  repoRoot: string,
  sourcePath: unknown,
  applicationName: string,
  applicationFile?: string,
) {
  const path = yield* Path.Path
  yield* validate(
    typeof sourcePath === "string",
    `${applicationName} local source path is not a string`,
    applicationFile,
  )

  const gitOpsRoot = path.join(repoRoot, "gitops")
  const absoluteSourcePath = path.resolve(repoRoot, sourcePath as string)
  const relativeSourcePath = path.relative(gitOpsRoot, absoluteSourcePath)
  yield* validate(
    (sourcePath as string).startsWith("gitops/") &&
      relativeSourcePath !== ".." &&
      !relativeSourcePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeSourcePath),
    `${applicationName} local source is outside gitops/: ${String(sourcePath)}`,
    applicationFile,
  )
  return absoluteSourcePath
})

export const requireLocalGitOpsSourceDirectory = Effect.fn("GitOps.requireLocalSource")(function* (
  repoRoot: string,
  sourcePath: unknown,
  applicationName: string,
  applicationFile?: string,
) {
  const path = yield* Path.Path
  const absoluteSourcePath = yield* resolveLocalGitOpsSourcePath(
    repoRoot,
    sourcePath,
    applicationName,
    applicationFile,
  )
  yield* requirePathType(
    absoluteSourcePath,
    "Directory",
    `${applicationName} local source does not exist: ${String(sourcePath)}`,
  )

  const [canonicalGitOpsRoot, canonicalSourcePath] = yield* Effect.all([
    resolveDirectory(path.join(repoRoot, "gitops")),
    resolveDirectory(absoluteSourcePath),
  ])
  const relativeSourcePath = path.relative(canonicalGitOpsRoot, canonicalSourcePath)
  yield* validate(
    relativeSourcePath !== ".." &&
      !relativeSourcePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeSourcePath),
    `${applicationName} local source is outside gitops/: ${String(sourcePath)}`,
    applicationFile,
  )
  return canonicalSourcePath
})

const validateApplication = Effect.fn("GitOps.validateApplication")(function* (options: {
  readonly applicationFile: string
  readonly applicationResource: string
  readonly cluster: string
  readonly declaredProjects: ReadonlySet<string>
  readonly repoRoot: string
  readonly root: RootApplication
}) {
  const path = yield* Path.Path
  const application = yield* readYamlRecord(options.applicationFile)
  const applicationName = stringAt(application, "metadata", "name")
  const project = stringAt(application, "spec", "project")
  const sources = sourcesOf(application)

  yield* validate(
    applicationName !== undefined && options.applicationResource === `${applicationName}.yaml`,
    `${options.applicationResource} contains Application ${applicationName ?? "<unnamed>"}`,
    options.applicationFile,
  )
  yield* validate(
    project !== "default",
    `${applicationName} uses the denied default AppProject`,
    options.applicationFile,
  )
  yield* validate(
    project !== undefined && options.declaredProjects.has(project),
    `${applicationName} references undeclared AppProject ${project ?? "<unnamed>"}`,
    options.applicationFile,
  )
  yield* validate(
    sources.length >= 1 && sources.length <= 3,
    `${applicationName} has ${sources.length} sources; expected one to three`,
    options.applicationFile,
  )
  yield* validate(
    field(application, "apiVersion") === "argoproj.io/v1alpha1" &&
      field(application, "kind") === "Application" &&
      stringAt(application, "metadata", "namespace") === options.root.namespace &&
      stringAt(application, "spec", "destination", "server") === options.root.server &&
      nestedValue(application, "metadata", "finalizers") == null,
    `${applicationName} metadata or destination is inconsistent with ${options.cluster}`,
    options.applicationFile,
  )

  const syncOptions = arrayAt(application, "spec", "syncPolicy", "syncOptions")
  yield* validate(
    syncOptions.includes("FailOnSharedResource=true"),
    `${applicationName} does not reject shared-resource ownership`,
    options.applicationFile,
  )

  const insecureSource = sources.find(
    (source) => !isSupportedSourceTransport(source),
  )
  yield* validate(
    insecureSource === undefined,
    `${applicationName} contains an unsupported source transport: ${stringAt(insecureSource, "repoURL") ?? "<missing>"}`,
    options.applicationFile,
  )
  const ambiguousGitSource = sources.find(
    (source) => {
      if (stringAt(source, "repoURL")?.startsWith("https://github.com/") !== true) {
        return false
      }

      const targetRevision = stringAt(source, "targetRevision")
      return (
        targetRevision !== "refs/heads/master" &&
        !immutableGitCommitPattern.test(targetRevision ?? "")
      )
    },
  )
  yield* validate(
    ambiguousGitSource === undefined,
    `${applicationName} contains an ambiguous Git revision: ${stringAt(ambiguousGitSource, "targetRevision") ?? "<missing>"}`,
    options.applicationFile,
  )

  if (sources.length >= 2) {
    yield* validate(
      sources.filter((source) => field(source, "ref") === "values").length === 1,
      `${applicationName} must have exactly one values source`,
      options.applicationFile,
    )
  }

  let namespaceCount = 0
  for (const source of sources) {
    const sourcePath = field(source, "path")
    if (stringAt(source, "repoURL") !== options.root.repositoryUrl || sourcePath == null) {
      continue
    }

    const absoluteSourcePath = yield* requireLocalGitOpsSourceDirectory(
      options.repoRoot,
      sourcePath,
      applicationName!,
      options.applicationFile,
    )

    if (yield* pathExists(path.join(absoluteSourcePath, "kustomization.yaml"))) {
      const rendered = yield* renderKustomization(absoluteSourcePath)
      const documents = yield* parseYamlDocuments(absoluteSourcePath, rendered)
      const namespaces = documents.filter((document) => field(document, "kind") === "Namespace")
      namespaceCount += namespaces.length
      yield* Effect.forEach(
        namespaces,
        (namespace) => validateNamespace(applicationName!, namespace),
        { discard: true },
      )
    }
  }

  const applicationSource = yield* readText(options.applicationFile)
  yield* validate(
    !obsoleteApplicationPattern.test(applicationSource),
    `${applicationName} contains obsolete sync or release metadata`,
    options.applicationFile,
  )

  return namespaceCount
})

const testGeneratorAtomicity = Effect.fn("GitOps.testGeneratorAtomicity")(function* (
  repoRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "gitops-atomic-" })
        .pipe(
          Effect.mapError(
            mapFileSystemError(repoRoot, "Unable to create the atomic generator test directory."),
          ),
        )
      const temporaryRepo = path.join(temporary, "repo")
      const temporaryGitOps = path.join(temporaryRepo, "gitops")
      yield* fileSystem
        .makeDirectory(temporaryRepo)
        .pipe(
          Effect.mapError(
            mapFileSystemError(temporaryRepo, "Unable to create the atomic generator repository."),
          ),
        )
      yield* fileSystem
        .copy(path.join(repoRoot, "gitops"), temporaryGitOps)
        .pipe(
          Effect.mapError(
            mapFileSystemError(temporaryGitOps, "Unable to stage the atomic generator test."),
          ),
        )

      const clusters = yield* listDirectories(path.join(temporaryGitOps, "clusters"))
      yield* validate(clusters.length > 0, "atomic generator test found no cluster")
      const applicationsDirectory = path.join(clusters[0]!, "applications")
      const kustomizationPath = path.join(applicationsDirectory, "kustomization.yaml")
      const kustomization = yield* readYamlRecord(kustomizationPath)
      const resources = [...arrayAt(kustomization, "resources"), "missing-template.yaml"]
      yield* writeText(kustomizationPath, stringify({ ...kustomization, resources }))

      const before = yield* snapshotDirectory(applicationsDirectory)
      const result = yield* Effect.either(generateGitOps({ repoRoot: temporaryRepo, check: false }))
      yield* validate(Either.isLeft(result), "generator accepted a missing template")
      const after = yield* snapshotDirectory(applicationsDirectory)
      yield* validate(
        JSON.stringify(before) === JSON.stringify(after),
        "failed generation partially changed committed output",
      )
    }),
  )
})

export type GitOpsCheckOptions = {
  readonly repoRoot: string
}

export const checkGitOps = Effect.fn("GitOps.check")(function* (options: GitOpsCheckOptions) {
  const path = yield* Path.Path
  const repoRoot = yield* resolveDirectory(options.repoRoot)
  const gitOpsRoot = path.join(repoRoot, "gitops")

  yield* generateGitOps({ repoRoot, check: true })
  yield* renderGitOps({ repoRoot })

  const allGitOpsFiles = yield* listFilesRecursive(gitOpsRoot)
  const projectFiles = allGitOpsFiles.filter((file) => file.endsWith(".appproject.yaml"))
  const projectNames = yield* Effect.forEach(
    projectFiles,
    (projectFile) =>
      readYamlRecord(projectFile).pipe(
        Effect.flatMap((project) => validateAppProject(projectFile, project)),
      ),
    { concurrency: 1 },
  )
  const declaredProjects = new Set(projectNames)

  const clusterDirectories = yield* listDirectories(path.join(gitOpsRoot, "clusters"))
  let namespaceCount = 0
  for (const clusterDirectory of clusterDirectories) {
    const cluster = path.basename(clusterDirectory)
    const applicationsDirectory = path.join(clusterDirectory, "applications")
    const bootstrapDirectory = path.join(clusterDirectory, "bootstrap")
    const applicationsKustomization = path.join(applicationsDirectory, "kustomization.yaml")
    const rootApplication = path.join(bootstrapDirectory, "argocd-app-of-apps.yaml")

    yield* validate(
      yield* pathExists(applicationsKustomization),
      `${cluster} is missing applications/kustomization.yaml`,
    )
    yield* validate(
      yield* pathExists(rootApplication),
      `${cluster} is missing bootstrap/argocd-app-of-apps.yaml`,
    )

    const root = yield* validateRootApplication(cluster, rootApplication)
    yield* validateBootstrapProject(
      cluster,
      path.join(bootstrapDirectory, "bootstrap.appproject.yaml"),
      root,
    )
    const kustomization = yield* readYamlRecord(applicationsKustomization)
    const resources = arrayAt(kustomization, "resources")
    yield* validate(resources.length > 0, `${cluster} declares no child Applications`)

    for (const resource of resources) {
      yield* validate(
        typeof resource === "string" && resourceFilePattern.test(resource),
        `${cluster} contains a non-local Application resource: ${String(resource)}`,
      )
      const applicationFile = path.join(applicationsDirectory, resource as string)
      yield* validate(
        yield* pathExists(applicationFile),
        `${cluster} references missing ${String(resource)}`,
      )
      namespaceCount += yield* validateApplication({
        applicationFile,
        applicationResource: resource as string,
        cluster,
        declaredProjects,
        repoRoot,
        root,
      })
    }
  }

  yield* validate(clusterDirectories.length > 0, "no GitOps clusters are declared")
  yield* validate(namespaceCount > 0, "no protected managed Namespaces are rendered")

  let obsoleteFile: string | undefined
  for (const file of allGitOpsFiles) {
    if (obsoleteGitOpsPattern.test(yield* readText(file))) {
      obsoleteFile = file
      break
    }
  }
  yield* validate(
    obsoleteFile === undefined,
    `obsolete GitOps paths or configuration remain${obsoleteFile ? ` in ${obsoleteFile}` : ""}`,
  )

  yield* testGeneratorAtomicity(repoRoot)
  yield* Console.log("GitOps generation, rendering, ownership, and policy checks passed.")
})

export const parseGitOpsCheckArguments = (
  argv: readonly string[],
  currentDirectory: string,
): Effect.Effect<GitOpsCheckOptions, GitOpsUsageError> =>
  argv.length <= 1
    ? Effect.succeed({ repoRoot: argv[0] ?? currentDirectory })
    : Effect.fail(
        new GitOpsUsageError({
          message: "Usage: gitops-check [REPO_ROOT]",
        }),
      )

export const runGitOpsCheckCli = Effect.fn("GitOps.checkCli")(function* (argv: readonly string[]) {
  const currentDirectory = yield* resolveDirectory(".")
  const options = yield* parseGitOpsCheckArguments(argv, currentDirectory)
  yield* checkGitOps(options)
})
