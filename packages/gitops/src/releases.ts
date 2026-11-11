import assert from "node:assert/strict"
import { parseDocument } from "yaml"

// Explicit onboarding only. Publishing another image never creates an application.
export const releaseApps = {
  "dotdev-web": {
    repository: "0xdsqr/dsqr-dotdev",
    branch: "master",
    workflow: "ci.yml",
    image: "ghcr.io/0xdsqr/dotdev-web",
    artifact: "image-digests",
    chart: "helm/dsqr-app",
    profile: "values-dotdev.yaml",
    namespace: "dsqr",
    kubeVersion: "1.36.0",
    applicationSet:
      "gitops/components/application-set/overlays/indigo/applications.applicationset.yaml",
    values: "gitops/components/dotdev/overlays/indigo/values-dotdev.yaml",
  },
} as const

export type ReleaseApp = keyof typeof releaseApps
export const shaPattern = /^[a-f0-9]{40}$/
export const digestPattern = /^sha256:[a-f0-9]{64}$/

export function releaseApp(value: string): ReleaseApp {
  assert.ok(Object.hasOwn(releaseApps, value), "Application is not onboarded for promotion")
  return value as ReleaseApp
}

export function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected object")
  return value as Record<string, unknown>
}

export function validateRun(app: ReleaseApp, value: unknown, head: string): string {
  const run = object(value)
  const config = releaseApps[app]
  assert.equal(object(run.repository).full_name, config.repository, "Wrong source repository")
  assert.equal(
    object(run.head_repository).full_name,
    config.repository,
    "Fork builds cannot promote",
  )
  assert.equal(run.path, `.github/workflows/${config.workflow}`, "Wrong release workflow")
  assert.ok(run.event === "push" || run.event === "workflow_dispatch", "Not a production build")
  assert.equal(run.head_branch, config.branch, "Not the production branch")
  assert.equal(run.status, "completed", "Build is not complete")
  assert.equal(run.conclusion, "success", "Build did not succeed")
  assert.match(head, shaPattern)
  assert.equal(run.head_sha, head, "Stale release: build is no longer the source branch head")
  return head
}

export function validateImages(app: ReleaseApp, value: unknown, commit: string): string {
  const record = object(object(value)[app])
  assert.equal(record.image, releaseApps[app].image, "Wrong image repository")
  assert.equal(record.commit, commit, "Image does not match the verified build")
  assert.equal(typeof record.digest, "string")
  assert.match(record.digest as string, digestPattern)
  assert.equal(record.ref, `${record.image}@${record.digest}`, "Image reference is not immutable")
  const platforms = object(record.platforms)
  for (const platform of ["linux/amd64", "linux/arm64"]) {
    assert.equal(typeof platforms[platform], "string", `Missing platform ${platform}`)
    assert.match(platforms[platform] as string, digestPattern)
  }
  return record.digest as string
}

function document(source: string) {
  const doc = parseDocument(source, { uniqueKeys: true })
  assert.equal(doc.errors.length, 0, "Invalid or ambiguous YAML")
  return doc
}

function revisionPath(source: string, app: ReleaseApp): (string | number)[] {
  const doc = document(source)
  const root = object(doc.toJS())
  assert.equal(root.kind, "ApplicationSet")
  const generators = object(root.spec).generators
  assert.ok(Array.isArray(generators))
  const matches: (string | number)[][] = []
  generators.forEach((generator, gi) => {
    const matrix = object(object(generator).matrix).generators
    assert.ok(Array.isArray(matrix))
    matrix.forEach((entry, mi) => {
      const elements = object(object(entry).list).elements
      assert.ok(Array.isArray(elements))
      elements.forEach((element, ei) => {
        if (object(element).name === app)
          matches.push([
            "spec",
            "generators",
            gi,
            "matrix",
            "generators",
            mi,
            "list",
            "elements",
            ei,
            "appRevision",
          ])
      })
    })
  })
  assert.equal(matches.length, 1, "Expected exactly one registered application")
  return matches[0]!
}

export function currentRevision(source: string, app: ReleaseApp): string {
  const revision = document(source).getIn(revisionPath(source, app))
  assert.equal(typeof revision, "string")
  assert.match(revision as string, shaPattern, "Production chart must be pinned")
  return revision as string
}

export function updateRelease(
  app: ReleaseApp,
  sources: { applicationSet: string; values: string },
  commit: string,
  digest: string,
  runId: string,
): { applicationSet: string; values: string } {
  assert.match(commit, shaPattern)
  assert.match(digest, digestPattern)
  assert.match(runId, /^[1-9][0-9]*$/)
  currentRevision(sources.applicationSet, app)
  const applicationSet = document(sources.applicationSet)
  const values = document(sources.values)
  const previousDigest = values.getIn(["image", "digest"])
  assert.equal(typeof previousDigest, "string")
  assert.match(previousDigest as string, digestPattern)
  applicationSet.setIn(revisionPath(sources.applicationSet, app), commit)
  values.setIn(["image", "digest"], digest)
  // Replace the existing release evidence comment; do not touch runtime settings.
  const renderedValues = values
    .toString()
    .replace(/^# CI [^\n]*$/m, `# CI ${runId}, ${releaseApps[app].repository} commit ${commit}.`)
  return { applicationSet: applicationSet.toString(), values: renderedValues }
}
