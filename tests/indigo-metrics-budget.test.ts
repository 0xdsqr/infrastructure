import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"

const path = "gitops/components/telemetry-metrics/overlays/indigo/config.alloy"
const config = readFileSync(path, "utf8")
const stage = config.split('prometheus.relabel "apiserver" {')[1].split("// Both KSM replicas")[0]
// Evaluate the production rules, not copies of their regexes. This deliberately
// supports only drop rules: adding transformations requires a new safety review.
const rules = [...stage.matchAll(/rule \{([^}]+)\}/g)].map(([, body]) => ({
  action: JSON.parse(body.match(/action\s*=\s*("[^"]*")/)![1]),
  labels: JSON.parse(body.match(/source_labels\s*=\s*(\[[^\]]*\])/)![1]) as string[],
  regex: new RegExp(`^(?:${JSON.parse(body.match(/regex\s*=\s*("[^"]*")/)![1])})$`),
}))
const kept = (__name__: string, le = "") => !rules.some(rule => {
  const labels: Record<string, string> = {__name__, le}
  return rule.regex.test(rule.labels.map(label => labels[label] ?? "").join(";"))
})
const bounds = ["0.005", "0.025", "0.05", "0.1", "0.2", "0.4", "0.6", "0.8", "1.0", "1.25",
  "1.5", "2.0", "3.0", "4.0", "5.0", "6.0", "8.0", "10.0", "15.0", "20.0", "30.0", "45.0", "60.0", "+Inf"]

test("cardinality reduction is wired only into Indigo's API-server scrape", () => {
  assert.equal(rules.length, 3)
  assert.ok(rules.every(r => r.action === "drop"))
  const scraper = config.split('prometheus.scrape "apiserver" {')[1].split('prometheus.relabel "apiserver"')[0]
  assert.match(scraper, /forward_to = \[prometheus.relabel.apiserver.receiver\]/)
  assert.equal((config.match(/prometheus.relabel.apiserver.receiver/g) ?? []).length, 1)
  assert.match(stage, /forward_to = \[prometheus.remote_write.beacon.receiver\]/)
  assert.doesNotMatch(stage, /action = "(labeldrop|labelkeep|replace|keep)"/)
})

test("all counters, gauges, histogram totals and full API SLI resolution survive", () => {
  for (const name of ["up", "scrape_samples_scraped", "apiserver_request_total", "apiserver_current_inflight_requests",
    "apiserver_flowcontrol_rejected_requests_total", "apiserver_storage_objects", "etcd_request_errors_total",
    "process_resident_memory_bytes", "go_goroutines", "kube_pod_status_phase", "container_cpu_usage_seconds_total"]) {
    assert.ok(kept(name), name)
  }
  for (const family of ["apiserver_request_duration_seconds", "etcd_request_duration_seconds",
    "apiserver_request_sli_duration_seconds", "apiserver_request_body_size_bytes", "apiserver_response_sizes",
    "apiserver_watch_events_sizes", "apiserver_watch_cache_read_wait_seconds", "apiserver_watch_list_duration_seconds"]) {
    for (const suffix of ["sum", "count"]) assert.ok(kept(`${family}_${suffix}`), `${family}_${suffix}`)
  }
  for (const bound of bounds) assert.ok(kept("apiserver_request_sli_duration_seconds_bucket", bound), bound)
  assert.ok(kept("apiserver_client_certificate_expiration_seconds_bucket", "0.025"))
  assert.ok(kept("kubelet_runtime_operations_duration_seconds_bucket", "0.025"))
})

test("selected latency histograms retain cumulative boundaries and +Inf without merging labels", () => {
  assert.deepEqual(bounds.filter(b => kept("apiserver_request_duration_seconds_bucket", b)),
    ["0.1", "0.2", "0.4", "0.8", "1.0", "2.0", "5.0", "10.0", "30.0", "60.0", "+Inf"])
  assert.deepEqual(bounds.filter(b => kept("etcd_request_duration_seconds_bucket", b)),
    ["0.005", "0.025", "0.05", "0.1", "0.2", "0.4", "0.8", "1.0", "2.0", "5.0", "10.0", "30.0", "60.0", "+Inf"])
  for (const family of ["apiserver_request_duration_seconds", "etcd_request_duration_seconds"]) {
    for (const bound of ["3", "3.0", "45", "45.0"]) assert.equal(kept(`${family}_bucket`, bound), false)
    assert.ok(kept(`${family}_bucket`, "0.075"), "future boundaries pass through")
  }
  for (const family of ["request_body_size_bytes", "response_sizes", "watch_events_sizes",
    "watch_cache_read_wait_seconds", "watch_list_duration_seconds"]) {
    assert.equal(kept(`apiserver_${family}_bucket`, "+Inf"), false)
    assert.ok(kept(`another_apiserver_${family}_bucket`, "+Inf"), "regexes must be anchored")
  }
})

test("pinned Alloy validates the complete production configuration", {skip: !process.env.ALLOY_TEST_BINARY}, () => {
  execFileSync(process.env.ALLOY_TEST_BINARY!, ["validate", path], {stdio: "pipe"})
})
