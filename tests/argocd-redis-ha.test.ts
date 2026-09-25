import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parse, parseAllDocuments } from "yaml"
import { previewApplicationSet } from "../packages/gitops/src/applicationset.ts"

const commonPath = "gitops/components/argocd/base/values-common.yaml"
const chart = process.env.ARGOCD_TEST_CHART
const render = (cluster: string, overrides: string[] = []) => parseAllDocuments(execFileSync("helm", [
  "template", "argocd", chart!, "--namespace", "argocd", "--kube-version", "1.36.3",
  "--values", commonPath,
  "--values", `gitops/components/argocd/overlays/${cluster}/values-overrides.yaml`,
  ...overrides,
], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }), { version: "1.1" }).map(d => d.toJSON()).filter(Boolean)

const matches = (selector: any, labels: any) =>
  Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value) &&
  (selector.matchExpressions ?? []).every((e: any) => e.operator === "In" && e.values.includes(labels[e.key]))

test("Redis HA profile uses an existing credential, bounded resources and no API privileges", () => {
  const ha = parse(readFileSync(commonPath, "utf8"))["redis-ha"]
  assert.equal(ha.enabled, false)
  assert.equal(ha.auth, true)
  assert.equal(ha.existingSecret, "argocd-redis")
  assert.equal(ha.sentinel.auth, true)
  assert.equal(ha.sentinel.existingSecret, "argocd-redis")
  assert.equal(ha.sentinel.authKey, "auth")
  assert.equal(ha.sentinel.quorum, 2)
  assert.equal(ha.persistentVolume.enabled, false)
  assert.equal(ha.rbac.create, false)
  assert.equal(ha.redis.config.save, '""')
  assert.equal(ha.redis.config.maxmemory, "256mb")
  assert.equal(ha.redis.updateStrategy.type, "RollingUpdate")
  // The lifecycle bridge is valid only while both services use this same key.
  assert.equal(ha.sentinel.existingSecret, ha.existingSecret)
  assert.equal(ha.sentinel.authKey, ha.authKey)
})

test("graceful-shutdown hook exports Sentinel authentication and refuses missing credentials", () => {
  const ha = parse(readFileSync(commonPath, "utf8"))["redis-ha"]
  const [shell, option, command] = ha.redis.lifecycle.preStop.exec.command
  assert.equal(shell, "/bin/sh")
  assert.equal(option, "-ec")
  const invoke = "exec timeout 35 /bin/sh /readonly-config/trigger-failover-if-master.sh"
  assert.ok(command.trimEnd().endsWith(invoke))
  // Substitute only the final upstream invocation. A child shell must inherit
  // the bridge, not just see a local unexported variable. No real keys used.
  const probe = command.replace(invoke, `exec /bin/sh -ec 'test "$SENTINELAUTH" = "$AUTH"'`)
  execFileSync(shell, [option, probe], { env: { AUTH: "test-only-value" }, stdio: "pipe" })
  for (const env of [{}, { AUTH: "" }]) {
    assert.throws(() => execFileSync(shell, [option, probe], { env, stdio: "pipe" }))
  }
  assert.deepEqual(ha.sentinel.lifecycle.preStop.exec.command, ["/bin/sh", "-ec", "sleep 40"])
  assert.equal(ha.redis.terminationGracePeriodSeconds, 60)
})

test("lifecycle fix is staged without automatically restarting any Redis pod", { skip: !chart }, () => {
  const objects = render("indigo")
  const statefulset = objects.find(o => o.kind === "StatefulSet" && o.metadata.name === "argocd-redis-ha-server")
  assert.deepEqual(statefulset.spec.updateStrategy, { type: "OnDelete" })
  const pod = statefulset.spec.template.spec
  const ha = parse(readFileSync(commonPath, "utf8"))["redis-ha"]
  assert.equal(pod.terminationGracePeriodSeconds, 60)
  for (const name of ["redis", "sentinel"]) {
    const container = pod.containers.find((c: any) => c.name === name)
    assert.deepEqual(container.lifecycle, ha[name].lifecycle)
  }
  const redis = pod.containers.find((c: any) => c.name === "redis")
  const sentinel = pod.containers.find((c: any) => c.name === "sentinel")
  assert.deepEqual(redis.env.find((e: any) => e.name === "AUTH").valueFrom.secretKeyRef,
    sentinel.env.find((e: any) => e.name === "SENTINELAUTH").valueFrom.secretKeyRef)
  const config = pod.volumes.find((v: any) => v.name === "config")
  assert.equal(config.configMap.name, "argocd-redis-ha-configmap")
  assert.ok(redis.volumeMounts.some((m: any) => m.name === "config" && m.mountPath === "/readonly-config" && m.readOnly))
  const scripts = objects.find(o => o.kind === "ConfigMap" && o.metadata.name === config.configMap.name).data
  assert.match(scripts["trigger-failover-if-master.sh"], /\$\{SENTINELAUTH\}/)
  assert.match(scripts["trigger-failover-if-master.sh"], /timeout=30/)
})

test("HA renders three separated Redis/Sentinel members, two proxies and quorum-safe PDBs", { skip: !chart }, () => {
  const objects = render("indigo")
  for (const [kind, name, replicas, pdbName, minAvailable] of [
    ["StatefulSet", "argocd-redis-ha-server", 3, "argocd-redis-ha-pdb", 2],
    ["Deployment", "argocd-redis-ha-haproxy", 2, "argocd-redis-ha-haproxy-pdb", 1],
  ] as const) {
    const workload = objects.find(o => o.kind === kind && o.metadata.name === name)
    assert.equal(workload.spec.replicas, replicas)
    const pod = workload.spec.template.spec
    assert.equal(pod.automountServiceAccountToken, false)
    const pdb = objects.find(o => o.kind === "PodDisruptionBudget" && o.metadata.name === pdbName)
    assert.equal(pdb.spec.minAvailable, minAvailable)
    assert.deepEqual(pdb.spec.selector, workload.spec.selector)
    const [affinity] = pod.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution
    assert.equal(affinity.topologyKey, "kubernetes.io/hostname")
    assert.ok(matches(affinity.labelSelector, workload.spec.template.metadata.labels))
    assert.equal(pod.volumes.some((v: any) => v.hostPath || v.persistentVolumeClaim), false)
    for (const c of [...pod.initContainers, ...pod.containers]) {
      assert.ok(c.resources.requests.cpu)
      assert.ok(c.resources.requests.memory)
      assert.ok(c.resources.limits.memory)
      assert.equal(c.securityContext.allowPrivilegeEscalation, false)
      assert.equal(c.securityContext.readOnlyRootFilesystem, true)
      assert.equal(c.securityContext.seccompProfile.type, "RuntimeDefault")
      assert.deepEqual(c.securityContext.capabilities.drop, ["ALL"])
      for (const e of (c.env ?? []).filter((e: any) => ["AUTH", "SENTINELAUTH"].includes(e.name))) {
        assert.deepEqual(e.valueFrom.secretKeyRef, { name: "argocd-redis", key: "auth" })
      }
    }
  }
  assert.equal(objects.some(o => ["Role", "RoleBinding", "Secret"].includes(o.kind) && o.metadata.name.includes("redis-ha")), false)
  const proxy = objects.find(o => o.kind === "Deployment" && o.metadata.name === "argocd-redis-ha-haproxy")
  assert.deepEqual(proxy.spec.strategy.rollingUpdate, { maxSurge: 1, maxUnavailable: 0 })
  const server = objects.find(o => o.kind === "StatefulSet" && o.metadata.name === "argocd-redis-ha-server")
  assert.deepEqual(server.spec.template.spec.containers.map((c: any) => c.name), ["redis", "sentinel", "split-brain-fix"])
})

test("HA policies allow only scoped clients, replication, Sentinel and CoreDNS", { skip: !chart }, () => {
  const objects = render("indigo")
  const policy = (name: string) => objects.find(o => o.kind === "NetworkPolicy" && o.metadata.name === name).spec
  const backend = policy("argocd-redis-ha-backend")
  const proxy = policy("argocd-redis-ha-proxy")
  const clients = policy("argocd-redis-ha-clients")
  const dns = {
    to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
      podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
    ports: [{ port: 53, protocol: "UDP" }, { port: 53, protocol: "TCP" }],
  }
  for (const p of [backend, proxy]) {
    assert.deepEqual(p.policyTypes, ["Ingress", "Egress"])
    assert.equal(p.egress.length, 2)
    assert.deepEqual(p.egress[1], dns)
    assert.deepEqual(p.egress[0], {
      to: [{ podSelector: { matchLabels: { release: "argocd", app: "redis-ha" } } }],
      ports: [{ port: 6379, protocol: "TCP" }, { port: 26379, protocol: "TCP" }],
    })
  }
  assert.deepEqual(backend.ingress, [{
    from: ["redis-ha", "redis-ha-haproxy"].map(app => ({ podSelector: { matchLabels: { release: "argocd", app } } })),
    ports: [{ port: 6379, protocol: "TCP" }, { port: 26379, protocol: "TCP" }],
  }])
  assert.deepEqual(proxy.ingress, [{ from: [{ podSelector: clients.podSelector }], ports: [{ port: 6379, protocol: "TCP" }] }])
  assert.deepEqual(clients.policyTypes, ["Egress"])
  assert.deepEqual(clients.egress, [{ to: [{ podSelector: proxy.podSelector }], ports: [{ port: 6379, protocol: "TCP" }] }])
  const allowed = ["argocd-server", "argocd-repo-server", "argocd-application-controller"]
  for (const o of objects.filter(o => ["Deployment", "StatefulSet", "Job"].includes(o.kind))) {
    assert.equal(matches(clients.podSelector, o.spec.template.metadata.labels), allowed.includes(o.metadata.name), o.metadata.name)
  }
  for (const [name, p] of [["argocd-redis-ha-server", backend], ["argocd-redis-ha-haproxy", proxy]] as const) {
    const pod = objects.find(o => ["Deployment", "StatefulSet"].includes(o.kind) && o.metadata.name === name).spec.template
    assert.ok(matches(p.podSelector, pod.metadata.labels))
  }
})

test("clients use the chart-selected HA endpoint while preserving credentials and manual no-prune sync", { skip: !chart }, () => {
  const objects = render("indigo")
  const params = objects.find(o => o.kind === "ConfigMap" && o.metadata.name === "argocd-cmd-params-cm")
  assert.equal(params.data["redis.server"], "argocd-redis-ha-haproxy:6379")
  const values = parse(readFileSync("gitops/components/argocd/overlays/indigo/values-overrides.yaml", "utf8"))
  assert.equal(values.configs.params["redis.server"], undefined)
  for (const name of ["argocd-server", "argocd-repo-server", "argocd-application-controller"]) {
    const pod = objects.find(o => ["Deployment", "StatefulSet"].includes(o.kind) && o.metadata.name === name).spec.template.spec
    const env = pod.containers[0].env.find((e: any) => e.name === "REDIS_SERVER")
    assert.deepEqual(env.valueFrom.configMapKeyRef, { name: "argocd-cmd-params-cm", key: "redis.server", optional: true })
    const password = pod.containers[0].env.find((e: any) => e.name === "REDIS_PASSWORD")
    assert.deepEqual(password.valueFrom.secretKeyRef, { name: "argocd-redis", key: "auth", optional: false })
  }
  // Keep pruning manual: the old standalone resources remain available for
  // rollback until the live client cutover has been independently verified.
  const applicationSet = parseAllDocuments(execFileSync("kubectl", ["kustomize", "gitops/clusters/indigo/applications"], { encoding: "utf8" }))[0].toJSON()
  const argo = (previewApplicationSet(applicationSet) as any[]).find(o => o.metadata.name === "argocd")
  assert.equal(argo.spec.syncPolicy.automated.enabled, false)
  assert.equal(argo.spec.syncPolicy.automated.prune, false)
  const hub = render("hub-a")
  assert.equal(hub.some(o => o.metadata.name.includes("redis-ha")), false)
  assert.ok(hub.some(o => o.kind === "Deployment" && o.metadata.name === "argocd-redis"))
})

test("endpoint cutover rolls Argo through chart checksums without changing the HA backend", { skip: !chart }, () => {
  const after = render("indigo")
  const before = render("indigo", ["--set-string", "configs.params.redis\\.server=argocd-redis:6379"])
  const id = (o: any) => `${o.kind}/${o.metadata.name}`
  assert.deepEqual(after.map(id), before.map(id))
  const expectedChanges = [
    "ConfigMap/argocd-cmd-params-cm",
    "Deployment/argocd-applicationset-controller",
    "Deployment/argocd-repo-server",
    "Deployment/argocd-server",
    "StatefulSet/argocd-application-controller",
  ]
  const changed = after.filter(o => JSON.stringify(o) !== JSON.stringify(before.find(p => id(p) === id(o))))
  assert.deepEqual(changed.map(id).sort(), expectedChanges.sort())
  for (const workload of changed.filter(o => ["Deployment", "StatefulSet"].includes(o.kind))) {
    const previous = before.find(o => id(o) === id(workload))
    const annotations = workload.spec.template.metadata.annotations
    const previousAnnotations = previous.spec.template.metadata.annotations
    assert.notEqual(annotations["checksum/cmd-params"], previousAnnotations["checksum/cmd-params"])
    const normalized = structuredClone(workload)
    normalized.spec.template.metadata.annotations["checksum/cmd-params"] = previousAnnotations["checksum/cmd-params"]
    assert.deepEqual(normalized, previous, id(workload))
  }
})
