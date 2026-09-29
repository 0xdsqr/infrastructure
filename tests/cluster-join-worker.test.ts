import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { rootCertificates } from "node:tls"
import test from "node:test"
import { Effect, Fiber } from "effect"
import { joinConfiguration, joinScript, joinWorker, parseJoinArgs, trustedCA, workerPreflight, type JoinIO, type ProcessOptions } from "../packages/cluster/src/join-worker.ts"
import { indigoWorkers } from "../packages/cluster/src/node-pools.ts"

const ca = Buffer.from(rootCertificates[0]!).toString("base64")
const cluster = { server: "https://10.10.80.10:6443", "certificate-authority-data": ca }
const token = "abcdef.0123456789abcdef"
const options = { worker: "04", identity: "/home/admin/key with spaces", apply: true }
type Call = { command: string; args: readonly string[]; options: ProcessOptions }
function fixture(overrides: { existing?: boolean; wrongCluster?: boolean; fail?: string; hangJoin?: boolean; tokenOutput?: string } = {}) {
  const calls: Call[] = []
  const io: JoinIO<never> = { run: (command, args, opts = {}) => Effect.suspend(() => {
    calls.push({ command, args, options: opts })
    const input = opts.input ?? ""
    const stage = input.includes("kubeadm token create") ? "create"
      : input.includes("kubeadm token delete") ? "revoke"
      : input.includes("kubeadm join --config") ? "join"
      : args.includes("wait") ? "wait"
      : args.includes("sudo -n kubeadm config validate --config /dev/stdin") ? "schema"
      : input.includes("test -S") ? "preflight" : "read"
    if (overrides.fail === stage) return Effect.fail(new Error("mock failure"))
    if (overrides.hangJoin && stage === "join") return Effect.never
    let stdout = ""
    if (args.includes("jsonpath={.clusters[0].cluster}")) stdout = JSON.stringify(overrides.wrongCluster ? { ...cluster, server: "https://wrong" } : cluster)
    if (args.includes("--ignore-not-found") && overrides.existing) stdout = "node/already-joined"
    if (stage === "create") stdout = overrides.tokenOutput ?? `${token}\n`
    return Effect.succeed({ stdout, stderr: "" })
  }) }
  return { io, calls }
}

test("join CLI requires declared worker, absolute identity and explicit unambiguous mode", () => {
  const base = ["join-worker", "indigo", "--worker", "04", "--identity", options.identity]
  assert.deepEqual(parseJoinArgs([...base, "--apply"]), options)
  assert.equal(parseJoinArgs([...base, "--check-only"]).apply, false)
  for (const args of [base, [...base, "--apply", "--check-only"], [...base, "--apply", "--force"], [...base, "--worker", "05", "--apply"],
    ["join-worker", "hub-a", "--worker", "04", "--identity", "/key", "--apply"],
    ["join-worker", "indigo", "--worker", "07", "--identity", "/key", "--apply"],
    ["join-worker", "indigo", "--worker", "04;reboot", "--identity", "/key", "--apply"],
    ["join-worker", "indigo", "--worker", "04", "--identity", "~/.ssh/key", "--apply"],
  ]) assert.throws(() => parseJoinArgs(args))
})

test("authenticated discovery validates endpoint, certificate and TLS verification", () => {
  assert.equal(trustedCA(JSON.stringify(cluster)), ca)
  for (const value of [{ ...cluster, server: "https://wrong" }, { ...cluster, "insecure-skip-tls-verify": true }, { server: cluster.server }, { ...cluster, "certificate-authority-data": "garbage" }]) {
    assert.throws(() => trustedCA(JSON.stringify(value)))
  }
})

test("every declared worker joins with its own address and pool isolation, retaining NixOS patches", () => {
  for (const worker of indigoWorkers) {
    const config = joinConfiguration(worker, "/run/test", token)
    assert.equal(config.nodeRegistration.name, worker.name)
    assert.deepEqual(config.nodeRegistration.kubeletExtraArgs, [{ name: "node-labels", value: `platform.dsqr.dev/node-pool=${worker.pool}` }])
    assert.deepEqual(config.nodeRegistration.taints, [{ key: "platform.dsqr.dev/dedicated", value: worker.pool, effect: "NoSchedule" }])
    assert.equal(config.patches.directory, "/etc/kubernetes/kubeadm/patches")
    assert.match(workerPreflight(worker), new RegExp(worker.address.replaceAll(".", "\\.")))
    for (const file of ["kubelet.conf", "bootstrap-kubelet.conf", "admin.conf", "manifests/kube-apiserver.yaml"]) assert.ok(workerPreflight(worker).includes(`test ! -e /etc/kubernetes/${file}`))
  }
})

test("remote join uses protected runtime files and scoped cleanup, never reset or unsafe CA bypass", () => {
  const script = joinScript(indigoWorkers[3], ca, token)
  assert.match(script, /umask 077/)
  assert.match(script, /ulimit -c 0/)
  assert.match(script, /mkdir -m 700/)
  assert.match(script, /trap cleanup EXIT/)
  assert.match(script, /trap 'exit 143' TERM HUP/)
  assert.doesNotMatch(script, /reset|unsafe-skip|ignore-preflight|rm -rf|set -x/)
  const encoded = [...script.matchAll(/printf '%s' '([^']+)'/g)].map(m => JSON.parse(Buffer.from(m[1]!, "base64").toString()))
  assert.equal(encoded[0].users[0].user.token, token)
  assert.equal(encoded[0].clusters[0].cluster["certificate-authority-data"], ca)
  assert.equal(encoded[1].discovery.tlsBootstrapToken, token)
  execFileSync("bash", ["-n"], { input: script })
})

test("check-only runs preflight/schema but never creates a token, joins, labels or taints live nodes", async () => {
  const f = fixture()
  await Effect.runPromise(joinWorker(f.io, { ...options, apply: false }, "/explicit/kubeconfig"))
  assert.ok(f.calls.some(c => c.args.includes("sudo -n kubeadm config validate --config /dev/stdin")))
  assert.ok(!f.calls.some(c => /token create|token delete|kubeadm join/.test(c.options.input ?? "")))
  assert.ok(!f.calls.some(c => c.args.includes("patch")))
  for (const call of f.calls.filter(c => c.command === "ssh")) {
    assert.ok(call.args.includes("StrictHostKeyChecking=yes"))
    assert.ok(call.args.includes(options.identity))
  }
})

test("wrong cluster, existing node, host or schema failure stops before token creation", async () => {
  for (const flags of [{ wrongCluster: true }, { existing: true }, { fail: "preflight" }, { fail: "schema" }]) {
    const f = fixture(flags)
    await assert.rejects(Effect.runPromise(joinWorker(f.io, options, "/explicit/kubeconfig")))
    assert.ok(!f.calls.some(c => c.options.input?.includes("token create")))
  }
})

test("apply creates a short-lived token, joins via stdin, revokes before readiness and never puts token in argv", async () => {
  const f = fixture()
  await Effect.runPromise(joinWorker(f.io, options, "/explicit/kubeconfig"))
  const create = f.calls.findIndex(c => c.options.input?.includes("token create"))
  const join = f.calls.findIndex(c => c.options.input?.includes("kubeadm join"))
  const revoke = f.calls.findIndex(c => c.options.input?.includes("token delete"))
  const ready = f.calls.findIndex(c => c.args.includes("wait"))
  assert.ok(create < join && join < revoke && revoke < ready)
  assert.ok(f.calls[ready]!.args.includes("--request-timeout=310s"))
  assert.match(f.calls[create]!.options.input!, /--ttl 30m/)
  assert.match(f.calls[create]!.options.input!, /sha256sum \/etc\/kubernetes\/pki\/ca.crt/)
  assert.match(f.calls[revoke]!.options.input!, /kubeadm token delete abcdef/)
  for (const c of f.calls) assert.ok(!c.args.join(" ").includes(token))
  assert.equal(f.calls[join]!.options.sensitive, true)
})

test("join failure and readiness timeout revoke tokens; failure never proceeds to readiness", async () => {
  for (const fail of ["join", "wait"]) {
    const f = fixture({ fail })
    await assert.rejects(Effect.runPromise(joinWorker(f.io, options, "/explicit/kubeconfig")), fail === "join" ? /Join failed/ : /readiness timed out/)
    assert.equal(f.calls.filter(c => c.options.input?.includes("token delete")).length, 1)
    if (fail === "join") assert.ok(!f.calls.some(c => c.args.includes("wait")))
  }
})

test("interruption during join still runs token revocation", async () => {
  const f = fixture({ hangJoin: true })
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.fork(joinWorker(f.io, options, "/explicit/kubeconfig"))
    yield* Effect.yieldNow()
    yield* Fiber.interrupt(fiber)
  }))
  assert.ok(f.calls.some(c => c.options.input?.includes("kubeadm join")))
  assert.ok(f.calls.some(c => c.options.input?.includes("token delete")))
})

test("failed or malformed token creation never joins; revocation failure retains TTL fallback", async () => {
  for (const flags of [{ fail: "create" }, { tokenOutput: "unexpected response" }]) {
    const f = fixture(flags)
    await assert.rejects(Effect.runPromise(joinWorker(f.io, options, "/explicit/kubeconfig")), /30 minutes/)
    assert.ok(!f.calls.some(c => c.options.input?.includes("kubeadm join")))
  }
  const f = fixture({ fail: "revoke" })
  await Effect.runPromise(joinWorker(f.io, options, "/explicit/kubeconfig"))
  assert.ok(f.calls.some(c => c.options.input?.includes("token delete")))
  assert.ok(f.calls.some(c => c.args.includes("wait")))
})

test("packaged CLI advertises join and ships SSH; temporary script paths do not leak into production", () => {
  const help = execFileSync(process.execPath, ["packages/cluster/src/bin.ts", "--help"], { encoding: "utf8" })
  assert.match(help, /cluster join-worker indigo/)
  assert.match(readFileSync("nix/packages/cluster.nix", "utf8"), /pkgs.openssh/)
  assert.doesNotMatch(readFileSync("packages/cluster/src/join-worker.ts", "utf8"), /\/private\/tmp|indigo-expansion\./)
})
