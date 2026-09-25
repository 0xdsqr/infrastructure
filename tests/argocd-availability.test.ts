import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"

const valuesPath = "gitops/components/argocd/overlays/indigo/values-overrides.yaml"
const chart = process.env.ARGOCD_TEST_CHART

test("Indigo enables bounded server/repo availability without changing controller or Redis topology", () => {
  const values = parse(readFileSync(valuesPath, "utf8"))
  for (const name of ["server", "repoServer"]) {
    const component = values[name]
    assert.equal(component.replicas, 2)
    assert.deepEqual(component.pdb, { enabled: true, minAvailable: 1 })
    assert.deepEqual(component.deploymentStrategy, {
      type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
    })
    assert.deepEqual(component.topologySpreadConstraints, [{
      maxSkew: 1, minDomains: 2, topologyKey: "kubernetes.io/hostname",
      whenUnsatisfiable: "DoNotSchedule", nodeTaintsPolicy: "Honor",
    }])
  }
  assert.equal(values.applicationSet.replicas, 1)
  assert.equal(values.controller.replicas, undefined)
  assert.equal(values["redis-ha"]?.enabled, undefined)
  assert.equal(values.redis.automountServiceAccountToken, false)
  assert.equal(values.repoServer.automountServiceAccountToken, false)
})

test("Pinned Argo chart renders replica spreading and matching PDBs only for Indigo", { skip: !chart }, () => {
  for (const cluster of ["indigo", "hub-a"]) {
    const objects = parseAllDocuments(execFileSync("helm", [
      "template", "argocd", chart!, "--namespace", "argocd", "--kube-version", "1.36.3",
      "--values", "gitops/components/argocd/base/values-common.yaml",
      "--values", `gitops/components/argocd/overlays/${cluster}/values-overrides.yaml`,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).map(d => d.toJSON()).filter(Boolean)
    for (const name of ["argocd-server", "argocd-repo-server"]) {
      const deployment = objects.find(o => o.kind === "Deployment" && o.metadata.name === name)
      const pdb = objects.find(o => o.kind === "PodDisruptionBudget" && o.metadata.name === name)
      assert.equal(deployment.spec.replicas, cluster === "indigo" ? 2 : 1)
      if (cluster === "hub-a") {
        assert.equal(pdb, undefined)
        continue
      }
      assert.equal(pdb.spec.minAvailable, 1)
      assert.deepEqual(pdb.spec.selector, deployment.spec.selector)
      assert.deepEqual(deployment.spec.strategy, {
        type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
      })
      const [spread] = deployment.spec.template.spec.topologySpreadConstraints
      assert.deepEqual(spread.labelSelector, deployment.spec.selector)
      assert.equal(spread.nodeTaintsPolicy, "Honor")
      assert.equal(spread.minDomains, 2)
      assert.equal(spread.maxSkew, 1)
      assert.equal(spread.topologyKey, "kubernetes.io/hostname")
      assert.equal(spread.whenUnsatisfiable, "DoNotSchedule")
      assert.ok(deployment.spec.template.spec.containers[0].resources.requests.memory)
    }
    assert.equal(objects.find(o => o.kind === "StatefulSet" && o.metadata.name === "argocd-application-controller").spec.replicas, 1)
    assert.ok(objects.some(o => o.kind === "Deployment" && o.metadata.name === "argocd-redis"))
  }
})
