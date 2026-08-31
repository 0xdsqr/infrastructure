#!/usr/bin/env node

import { Command, Path } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Console, Data, Effect, Option, Stream } from "effect"

const usage = `Usage:
  cluster bootstrap indigo --step argocd
  cluster bootstrap indigo --step root
  cluster bootstrap indigo --step cilium-adoption
  cluster validate indigo

The bootstrap commands are deliberately explicit and safe to rerun. They
require KUBECONFIG and refuse to mutate a cluster whose API server is not the
declared Indigo endpoint (https://10.10.80.10:6443).

Steps:
  argocd            install or upgrade the pinned Argo CD Helm release
  root              apply the AppProject, RBAC, and app-of-apps root
  cilium-adoption   perform the deliberate, non-pruning Cilium ownership handoff`

class ClusterError extends Data.TaggedError("ClusterError")<{
  readonly message: string
}> {}

type Result = {
  readonly stderr: string
  readonly stdout: string
}

const run = Effect.fn("Cluster.run")(function* (command: string, args: readonly string[]) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Command.start(Command.make(command, ...args)).pipe(
        Effect.mapError(
          (cause) => new ClusterError({ message: `Unable to start ${command}: ${String(cause)}` }),
        ),
      )
      const result = yield* Effect.all(
        {
          exitCode: process.exitCode,
          stderr: process.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold("", (output, chunk) => output + chunk),
          ),
          stdout: process.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold("", (output, chunk) => output + chunk),
          ),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause) => new ClusterError({ message: `Unable to run ${command}: ${String(cause)}` }),
        ),
      )

      if (result.exitCode !== 0) {
        return yield* new ClusterError({
          message: `${command} ${args.join(" ")} failed (${result.exitCode})${
            result.stderr.trim() === "" ? "" : `\n${result.stderr.trim()}`
          }`,
        })
      }
      return result satisfies Result
    }),
  )
})

const kubeconfig = Effect.fn("Cluster.kubeconfig")(function* () {
  const value = yield* Config.string("KUBECONFIG").pipe(
    Effect.mapError(
      () =>
        new ClusterError({
          message: "KUBECONFIG must name the explicit Indigo administrator kubeconfig.",
        }),
    ),
  )
  const normalized = value.trim()
  if (normalized === "") {
    return yield* new ClusterError({
      message: "KUBECONFIG must name the explicit Indigo administrator kubeconfig.",
    })
  }
  return normalized
})

const kubectl = (args: readonly string[]) =>
  kubeconfig().pipe(Effect.flatMap((config) => run("kubectl", ["--kubeconfig", config, ...args])))

const guardIndigo = Effect.fn("Cluster.guardIndigo")(function* () {
  const result = yield* kubectl([
    "config",
    "view",
    "--minify",
    "--output=jsonpath={.clusters[0].cluster.server}",
  ])
  const server = result.stdout.trim()
  if (server !== "https://10.10.80.10:6443") {
    return yield* new ClusterError({
      message: `Refusing to mutate ${server || "an unknown cluster"}; expected https://10.10.80.10:6443.`,
    })
  }
  yield* Console.log(`guard: indigo (${server})`)
})

const gitOpsPath = (...segments: readonly string[]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const override = yield* Config.option(Config.string("CLUSTER_REPO_ROOT")).pipe(
      Effect.mapError(
        () =>
          new ClusterError({
            message: "Unable to read the optional CLUSTER_REPO_ROOT runtime override.",
          }),
      ),
    )
    const repositoryRoot = Option.isSome(override) ? path.resolve(override.value) : process.cwd()
    return path.join(repositoryRoot, "gitops", ...segments)
  })

const bootstrapArgo = Effect.fn("Cluster.bootstrapArgo")(function* () {
  yield* guardIndigo()
  const config = yield* kubeconfig()
  const commonValues = yield* gitOpsPath("components", "argocd", "base", "values-common.yaml")
  const indigoValues = yield* gitOpsPath(
    "components",
    "argocd",
    "overlays",
    "indigo",
    "values-overrides.yaml",
  )
  yield* run("helm", [
    "--kubeconfig",
    config,
    "upgrade",
    "--install",
    "argocd",
    "oci://ghcr.io/argoproj/argo-helm/argo-cd",
    "--version",
    "10.2.1",
    "--namespace",
    "argocd",
    "--create-namespace",
    "--values",
    commonValues,
    "--values",
    indigoValues,
    "--atomic",
    "--wait",
    "--timeout",
    "10m",
  ])
  yield* Console.log("bootstrap: Argo CD 10.2.1 is ready")
})

const bootstrapRoot = Effect.fn("Cluster.bootstrapRoot")(function* () {
  yield* guardIndigo()
  const bootstrapPath = yield* gitOpsPath("clusters", "indigo", "bootstrap")
  const result = yield* kubectl([
    "apply",
    "--server-side",
    "--field-manager=cluster-bootstrap",
    "--kustomize",
    bootstrapPath,
  ])
  yield* Console.log(result.stdout.trim())
})

const adoptCilium = Effect.fn("Cluster.adoptCilium")(function* () {
  yield* guardIndigo()
  const revision = yield* kubectl([
    "--namespace",
    "argocd",
    "get",
    "application",
    "cilium",
    "--output=jsonpath={.spec.sources[0].targetRevision}",
  ])
  if (revision.stdout.trim() !== "1.20.1") {
    return yield* new ClusterError({
      message: `Refusing Cilium handoff at revision ${revision.stdout.trim() || "<unknown>"}; expected 1.20.1.`,
    })
  }

  yield* kubectl([
    "--namespace",
    "argocd",
    "annotate",
    "application",
    "cilium",
    "argocd.argoproj.io/refresh=hard",
    "--overwrite",
  ])
  yield* kubectl([
    "--namespace",
    "argocd",
    "patch",
    "application",
    "cilium",
    "--type=merge",
    "--patch",
    JSON.stringify({
      operation: {
        sync: {
          prune: false,
          syncOptions: ["FailOnSharedResource=true", "RespectIgnoreDifferences=true"],
        },
      },
    }),
  ])
  yield* kubectl([
    "--namespace",
    "argocd",
    "wait",
    "--for=jsonpath={.status.operationState.phase}=Succeeded",
    "application/cilium",
    "--timeout=10m",
  ])
  yield* Console.log("handoff: Argo CD owns Cilium without pruning live resources")
})

const validateIndigo = Effect.fn("Cluster.validateIndigo")(function* () {
  yield* guardIndigo()
  yield* kubectl(["get", "--raw=/livez"])
  yield* kubectl(["wait", "--for=condition=Ready", "node", "--all", "--timeout=2m"])
  yield* kubectl([
    "--namespace",
    "kube-system",
    "rollout",
    "status",
    "daemonset/cilium",
    "--timeout=2m",
  ])
  yield* kubectl([
    "--namespace",
    "kube-system",
    "rollout",
    "status",
    "deployment/cilium-operator",
    "--timeout=2m",
  ])
  const applications = yield* kubectl([
    "--namespace",
    "argocd",
    "get",
    "applications",
    "--output=wide",
  ])
  yield* Console.log(applications.stdout.trim())
})

type Action = "argocd" | "cilium-adoption" | "help" | "root" | "validate"

const parse = (argv: readonly string[]): Effect.Effect<Action, ClusterError> => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return Effect.succeed("help" as const)
  }
  if (argv[0] === "validate" && argv[1] === "indigo" && argv.length === 2) {
    return Effect.succeed("validate" as const)
  }
  if (
    argv[0] === "bootstrap" &&
    argv[1] === "indigo" &&
    argv[2] === "--step" &&
    argv.length === 4 &&
    ["argocd", "root", "cilium-adoption"].includes(argv[3] ?? "")
  ) {
    return Effect.succeed(argv[3] as "argocd" | "root" | "cilium-adoption")
  }
  return Effect.fail(new ClusterError({ message: `Invalid arguments.\n\n${usage}` }))
}

const program = parse(process.argv.slice(2)).pipe(
  Effect.flatMap((action) => {
    switch (action) {
      case "help":
        return Console.log(usage)
      case "validate":
        return validateIndigo()
      case "argocd":
        return bootstrapArgo()
      case "root":
        return bootstrapRoot()
      case "cilium-adoption":
        return adoptCilium()
    }
  }),
  Effect.catchTag("ClusterError", ({ message }) =>
    Console.error(message).pipe(Effect.zipRight(Effect.fail(new Error(message)))),
  ),
  Effect.provide(NodeContext.layer),
)

NodeRuntime.runMain(program)
