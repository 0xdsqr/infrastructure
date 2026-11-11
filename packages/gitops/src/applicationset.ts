import { execFileSync } from "node:child_process"
import { parse } from "yaml"
import { isRecord, type YamlRecord } from "./runtime.ts"

const record = (value: unknown): YamlRecord => {
  if (!isRecord(value)) throw new Error("Expected an ApplicationSet inventory object")
  return value
}

const merge = (base: YamlRecord, patch: YamlRecord): YamlRecord => {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = isRecord(value) && isRecord(result[key]) ? merge(result[key], value) : value
  }
  return result
}

// Preview our explicitly supported native matrix profile for validation.
// Never writes Application YAML or participates in live reconciliation.
export const previewApplicationSet = (applicationSet: YamlRecord): YamlRecord[] => {
  const spec = record(applicationSet.spec)
  const syncPolicy = record(spec.syncPolicy)
  if (spec.goTemplate !== true || JSON.stringify(spec.goTemplateOptions) !== '["missingkey=error"]')
    throw new Error("Native ApplicationSets must use strict Go templates")
  if (
    syncPolicy.applicationsSync !== "create-update" ||
    syncPolicy.preserveResourcesOnDeletion !== true
  )
    throw new Error("Native ApplicationSets must preserve Applications and deployed resources")
  const generators = spec.generators
  if (!Array.isArray(generators) || generators.length !== 1)
    throw new Error("Expected one native matrix generator")
  const children = record(record(generators[0]).matrix).generators
  if (!Array.isArray(children) || children.length !== 2)
    throw new Error("Expected two matrix inventories")
  const inventories = children.map((child) => {
    const generator = record(child)
    if (generator.list !== undefined) {
      const elements = record(generator.list).elements
      if (!Array.isArray(elements) || elements.length === 0)
        throw new Error("ApplicationSet inventory cannot be empty")
      return elements.map(record)
    }
    if (generator.git !== undefined) {
      const git = record(generator.git)
      if (
        typeof git.repoURL !== "string" ||
        git.revision !== "refs/heads/master" ||
        !Array.isArray(git.files) ||
        git.files.length !== 1
      )
        throw new Error("Git file inventory must pin one path on master")
      const file = record(git.files[0])
      if (
        typeof file.path !== "string" ||
        !/^apps\/[a-z][a-z0-9-]*\/environments\/[a-z][a-z0-9-]*\/release\.yaml$/.test(file.path)
      )
        throw new Error("Git file inventory uses an unsafe release path")
      // CI cannot read a private repository. Supply a structurally valid placeholder
      // solely to render and validate the public, privilege-bearing template.
      return [{ sourceRevision: "0".repeat(40) }]
    }
    throw new Error("Unsupported matrix inventory generator")
  })
  const requests = inventories[0]!.flatMap((left) =>
    inventories[1]!.map((right) => {
      if (Object.keys(right).some((key) => key in left))
        throw new Error("Matrix inventory keys must not overlap")
      const params = { ...left, ...right }
      if (!["controller", "configuration", "foundation"].includes(String(params.lifecycle)))
        throw new Error("Unknown Application lifecycle")
      if (!["standard", "extended"].includes(String(params.retryProfile)))
        throw new Error("Unknown Application retry profile")
      if (params.includeManifests !== undefined && typeof params.includeManifests !== "boolean")
        throw new Error("includeManifests must be a boolean")
      // Keep chart companion resources separate from another Application's
      // configuration overlay without permitting arbitrary repository paths.
      if (
        params.manifestSubdirectory !== undefined &&
        (params.includeManifests !== true ||
          !Array.isArray(params.charts) ||
          params.charts.length === 0 ||
          typeof params.manifestSubdirectory !== "string" ||
          !/^[a-z][a-z0-9-]*$/.test(params.manifestSubdirectory))
      )
        throw new Error(
          "manifestSubdirectory requires chart companions and one safe directory name",
        )
      return {
        template: spec.template,
        patch: spec.templatePatch,
        params,
      }
    }),
  )
  const binary = process.env.GITOPS_TEMPLATE_RENDERER ?? "gitops-template-render"
  const rendered = JSON.parse(
    execFileSync(binary, [], {
      input: JSON.stringify(requests),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    }),
  ) as { template: YamlRecord; patch: string }[]
  const applications: YamlRecord[] = rendered.map((result) => ({
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    ...merge(result.template, record(parse(result.patch))),
  }))
  const names = applications.map(
    (application) =>
      String(record(application.metadata).namespace) +
      "/" +
      String(record(application.metadata).name),
  )
  if (new Set(names).size !== applications.length)
    throw new Error("Duplicate generated Application identity")
  return applications
}
