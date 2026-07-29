import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const values = readFileSync(
  new URL("../gitops/values/k8s-monitoring/common.yaml", import.meta.url),
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
