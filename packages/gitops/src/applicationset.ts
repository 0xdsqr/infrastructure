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

// Preview our explicitly supported native matrix/list profile for validation.
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
    throw new Error("Expected cluster and component list inventories")
  const inventories = children.map((child) => {
    const elements = record(record(child).list).elements
    if (!Array.isArray(elements) || elements.length === 0)
      throw new Error("ApplicationSet inventory cannot be empty")
    return elements.map(record)
  })
  const requests = inventories[0]!.flatMap((cluster) =>
    inventories[1]!.map((component) => {
      if (Object.keys(component).some((key) => key in cluster))
        throw new Error("Cluster and component inventory keys must not overlap")
      if (!["controller", "configuration", "foundation"].includes(String(component.lifecycle)))
        throw new Error("Unknown Application lifecycle")
      if (!["standard", "extended"].includes(String(component.retryProfile)))
        throw new Error("Unknown Application retry profile")
      return {
        template: spec.template,
        patch: spec.templatePatch,
        params: { ...cluster, ...component },
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
