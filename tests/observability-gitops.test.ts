import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const values = readFileSync(
  new URL("../gitops/components/k8s-monitoring/base/values-common.yaml", import.meta.url),
  "utf8",
)

test("Kubernetes logs use durable delivery and collect cluster events", () => {
  assert.match(values, /writeAheadLog:\n\s+enabled: true/)
  assert.match(values, /maxBackoffRetries: 20/)
  assert.match(values, /clusterEvents:\n\s+enabled: true/)
  assert.match(values, /collector: alloy-singleton/)
  assert.match(values, /destinations: \["loki"\]/)
  assert.match(values, /alloy-singleton:\n\s+presets: \[small, deployment\]/)
  assert.match(values, /stabilityLevel: experimental/)
})

test("Kubernetes profiling is application-scoped and least-privilege", () => {
  assert.match(values, /pyroscope:\n\s+type: pyroscope\n\s+url: http:\/\/10\.10\.30\.102:4040/)
  assert.match(values, /profiling:\n\s+enabled: true\n\s+collector: alloy-profiles/)
  assert.match(values, /namespaces: \["dsqr", "fidara", "twt"\]/)
  assert.match(values, /presets: \[small, daemonset, host-tracefs\]/)
  assert.match(values, /allowPrivilegeEscalation: false/)
  assert.match(values, /privileged: false/)
  assert.match(values, /drop: \["ALL"\]/)
  assert.match(values, /- BPF/)
  assert.match(values, /- PERFMON/)
  assert.match(values, /hostPID: true/)
})
