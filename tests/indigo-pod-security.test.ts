import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"

const read = (path: string) => parse(readFileSync(path, "utf8"))
const render = (component: string, chart: string, namespace: string, cluster = "indigo") =>
  parseAllDocuments(execFileSync("helm", ["template", component, chart, "--namespace", namespace,
    "-f", `gitops/components/${component}/base/values-common.yaml`,
    "-f", `gitops/components/${component}/overlays/${cluster}/values-overrides.yaml`,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })).map(d => d.toJSON()).filter(Boolean)

test("Indigo admission pins restricted policies while preserving MetalLB's exception", () => {
  const ns = parseAllDocuments(execFileSync("kubectl", ["kustomize", "gitops/components/cluster-foundation/overlays/indigo"], { encoding: "utf8" }))
    .map(d => d.toJSON()).filter(r => r.kind === "Namespace")
  for (const name of ["argocd", "external-secrets", "envoy-gateway-system", "gateway-system"]) {
    const labels = ns.find(r => r.metadata.name === name).metadata.labels
    for (const mode of ["enforce", "warn", "audit"]) {
      assert.equal(labels[`pod-security.kubernetes.io/${mode}`], "restricted")
      assert.equal(labels[`pod-security.kubernetes.io/${mode}-version`], "v1.36")
    }
  }
  assert.equal(ns.find(r => r.metadata.name === "metallb-system").metadata.labels["pod-security.kubernetes.io/enforce"], "privileged")
  assert.equal(ns.some(r => r.metadata.name === "kube-system"), false)
})

test("token changes are Indigo-only and do not remove controller credentials", () => {
  const values = read("gitops/components/argocd/overlays/indigo/values-overrides.yaml")
  assert.equal(values.redis.automountServiceAccountToken, false)
  assert.equal(values.repoServer.automountServiceAccountToken, false)
  assert.equal(values.repoServer.serviceAccount.automountServiceAccountToken, false)
  for (const component of ["controller", "server", "applicationSet", "redisSecretInit"]) {
    assert.notEqual(values[component]?.automountServiceAccountToken, false)
    assert.notEqual(values[component]?.serviceAccount?.automountServiceAccountToken, false)
  }
})

const argoChart = process.env.ARGOCD_TEST_CHART
test("rendered Argo pods and hooks retain restricted security and correct API access", { skip: !argoChart }, () => {
  for (const cluster of ["indigo", "hub-a"]) {
    const resources = render("argocd", argoChart!, "argocd", cluster)
    for (const name of ["argocd-redis", "argocd-repo-server"]) {
      assert.equal(resources.find(r => r.kind === "Deployment" && r.metadata.name === name).spec.template.spec.automountServiceAccountToken, cluster !== "indigo")
    }
    if (cluster !== "indigo") continue
    for (const name of ["argocd-server", "argocd-application-controller", "argocd-applicationset-controller", "argocd-redis-secret-init"]) {
      const spec = resources.find(r => ["Deployment", "StatefulSet", "Job"].includes(r.kind) && r.metadata.name === name).spec.template.spec
      const sa = resources.find(r => r.kind === "ServiceAccount" && r.metadata.name === spec.serviceAccountName)
      assert.notEqual(spec.automountServiceAccountToken, false, name)
      assert.notEqual(sa.automountServiceAccountToken, false, name)
    }
    for (const r of resources.filter(r => ["Deployment", "StatefulSet", "Job"].includes(r.kind))) {
      const spec = r.spec.template.spec
      for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
        const sc = { ...spec.securityContext, ...c.securityContext }
        assert.equal(sc.runAsNonRoot, true, `${r.metadata.name}/${c.name}`)
        assert.equal(sc.allowPrivilegeEscalation, false)
        assert.equal(sc.seccompProfile.type, "RuntimeDefault")
        assert.deepEqual(sc.capabilities.drop, ["ALL"])
      }
    }
  }
})

const metallbChart = process.env.METALLB_TEST_CHART
test("MetalLB controller gains seccomp without changing the speaker", { skip: !metallbChart }, () => {
  const resources = render("metallb", metallbChart!, "metallb-system")
  const controller = resources.find(r => r.kind === "Deployment" && r.metadata.name === "metallb-controller").spec.template.spec
  assert.equal(controller.securityContext.seccompProfile.type, "RuntimeDefault")
  assert.equal(controller.securityContext.runAsNonRoot, true)
  assert.equal(controller.securityContext.runAsUser, 65534)
  const speaker = resources.find(r => r.kind === "DaemonSet").spec.template.spec
  assert.equal(speaker.hostNetwork, true)
  assert.ok(speaker.containers.find(c => c.name === "speaker").securityContext.capabilities.add.includes("NET_RAW"))
  assert.equal(speaker.securityContext?.seccompProfile, undefined)
})

const externalSecretsChart = process.env.EXTERNAL_SECRETS_TEST_CHART
test("External Secrets workloads and hooks are ready for restricted admission", { skip: !externalSecretsChart }, () => {
  const resources = render("external-secrets", externalSecretsChart!, "external-secrets")
  for (const r of resources.filter(r => ["Deployment", "StatefulSet", "DaemonSet", "Job"].includes(r.kind))) {
    const spec = r.spec.template.spec
    assert.notEqual(spec.hostNetwork, true)
    assert.notEqual(spec.hostPID, true)
    assert.notEqual(spec.hostIPC, true)
    for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
      const sc = { ...spec.securityContext, ...c.securityContext }
      assert.equal(sc.runAsNonRoot, true, `${r.metadata.name}/${c.name}`)
      assert.equal(sc.allowPrivilegeEscalation, false)
      assert.equal(sc.seccompProfile.type, "RuntimeDefault")
      assert.deepEqual(sc.capabilities.drop, ["ALL"])
      assert.notEqual(sc.privileged, true)
    }
  }
})
