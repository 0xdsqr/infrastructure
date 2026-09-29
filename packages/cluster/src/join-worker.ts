import { createHash, X509Certificate } from "node:crypto"
import { Console, Effect } from "effect"
import { dedicatedKey, indigoWorkers, poolLabel } from "./node-pools.ts"

export type JoinOptions = { worker: string; identity: string; apply: boolean }
export type ProcessOptions = { input?: string; sensitive?: boolean }
export type JoinIO<R> = {
  run: (command: string, args: readonly string[], options?: ProcessOptions) => Effect.Effect<{ stdout: string; stderr: string }, Error, R>
}
const endpoint = "https://10.10.80.10:6443"

export function parseJoinArgs(args: readonly string[]): JoinOptions {
  if (args[0] !== "join-worker" || args[1] !== "indigo") throw new Error("Expected join-worker indigo.")
  const flags = new Map<string, string>()
  let mode: string | undefined
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--apply" || arg === "--check-only") {
      if (mode) throw new Error("Choose exactly one of --check-only or --apply.")
      mode = arg
    } else if (arg === "--worker" || arg === "--identity") {
      const value = args[++i]
      if (!value || value.startsWith("--") || flags.has(arg)) throw new Error(`Invalid or repeated ${arg}.`)
      flags.set(arg, value)
    } else throw new Error(`Unknown join option: ${arg}`)
  }
  const worker = flags.get("--worker") ?? ""
  const identity = flags.get("--identity") ?? ""
  if (!indigoWorkers.some(w => w.name === `srv-lx-k8s-indigo-worker-${worker}`)) throw new Error("Worker must be in the declared Indigo inventory (01–06).")
  if (!identity.startsWith("/") || ["\r", "\n", String.fromCharCode(0)].some(c => identity.includes(c))) throw new Error("--identity must be an absolute SSH key path.")
  if (!mode) throw new Error("Specify --check-only or --apply explicitly.")
  return { worker, identity, apply: mode === "--apply" }
}

export function trustedCA(clusterJSON: string): string {
  const cluster = JSON.parse(clusterJSON) as Record<string, unknown>
  if (cluster.server !== endpoint || cluster["insecure-skip-tls-verify"] === true) throw new Error("Expected verified Indigo API endpoint.")
  const ca = cluster["certificate-authority-data"]
  if (typeof ca !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(ca)) throw new Error("Indigo kubeconfig needs an embedded CA certificate.")
  const cert = new X509Certificate(Buffer.from(ca, "base64"))
  if (!cert.ca) throw new Error("Discovery certificate is not a CA.")
  return ca
}

export function workerPreflight(worker: typeof indigoWorkers[number]): string {
  return `set -euo pipefail
test "$(cat /proc/sys/kernel/hostname)" = "${worker.name}"
test ! -e /etc/kubernetes/kubelet.conf
test ! -e /etc/kubernetes/bootstrap-kubelet.conf
test ! -e /etc/kubernetes/admin.conf
test ! -e /etc/kubernetes/manifests/kube-apiserver.yaml
test -S /run/containerd/containerd.sock
test -d /etc/kubernetes/kubeadm/patches
grep -Fq -- "--node-ip=${worker.address}" /etc/default/kubelet
ip -4 -o addr show | grep -Fq ' ${worker.address}/'
systemctl is-active --quiet containerd
`
}

export function joinConfiguration(worker: typeof indigoWorkers[number], directory: string, token: string) {
  return {
    apiVersion: "kubeadm.k8s.io/v1beta4", kind: "JoinConfiguration",
    discovery: { file: { kubeConfigPath: `${directory}/discovery.json` }, tlsBootstrapToken: token },
    patches: { directory: "/etc/kubernetes/kubeadm/patches" },
    nodeRegistration: {
      name: worker.name, criSocket: "unix:///run/containerd/containerd.sock",
      kubeletExtraArgs: [{ name: "node-labels", value: `${poolLabel}=${worker.pool}` }],
      taints: [{ key: dedicatedKey, value: worker.pool, effect: "NoSchedule" }],
    },
  }
}

export function joinScript(worker: typeof indigoWorkers[number], ca: string, token: string): string {
  if (!/^[a-z0-9]{6}\.[a-z0-9]{16}$/.test(token)) throw new Error("Invalid bootstrap token.")
  const directory = `/run/kubeadm-indigo-worker-${worker.name.slice(-2)}`
  const discovery = {
    apiVersion: "v1", kind: "Config",
    clusters: [{ name: "indigo", cluster: { server: endpoint, "certificate-authority-data": ca } }],
    users: [{ name: "bootstrap", user: { token } }],
    contexts: [{ name: "bootstrap", context: { cluster: "indigo", user: "bootstrap" } }],
    "current-context": "bootstrap",
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64")
  return workerPreflight(worker) + `
ulimit -c 0
umask 077
workdir="${directory}"
# mkdir intentionally refuses stale workdirs and symlinks; never overwrite them.
mkdir -m 700 "$workdir"
cleanup() { rm -f -- "$workdir/join.json" "$workdir/discovery.json"; rmdir -- "$workdir"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
printf '%s' '${encode(discovery)}' | base64 --decode > "$workdir/discovery.json"
printf '%s' '${encode(joinConfiguration(worker, directory, token))}' | base64 --decode > "$workdir/join.json"
kubeadm join --config "$workdir/join.json"
`
}

// Dependencies are injected so tests never need SSH, administrator credentials,
// token creation or a real node. Secret-bearing commands suppress all diagnostics.
export const joinWorker = <R>(io: JoinIO<R>, options: JoinOptions, kubeconfig: string) => Effect.gen(function* () {
  const worker = indigoWorkers.find(w => w.name === `srv-lx-k8s-indigo-worker-${options.worker}`)
  if (!worker) return yield* Effect.fail(new Error("Worker not in declared inventory."))
  const kubectl = (args: readonly string[], timeout = "15s") => io.run("kubectl", ["--kubeconfig", kubeconfig, `--request-timeout=${timeout}`, ...args])
  const sshOptions = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=yes", "-i", options.identity]
  const ssh = (address: string, input: string) => io.run("ssh", [...sshOptions, `dsqr@${address}`, "sudo -n bash -s"], { input, sensitive: true })
  const discovery = yield* kubectl(["config", "view", "--minify", "--flatten", "--raw", "-o", "jsonpath={.clusters[0].cluster}"])
  const ca = yield* Effect.try({ try: () => trustedCA(discovery.stdout), catch: () => new Error("Refusing join: expected Indigo endpoint with a valid CA and TLS verification.") })
  yield* kubectl(["get", "--raw=/readyz"])
  const existing = yield* kubectl(["get", "node", worker.name, "--ignore-not-found", "-o", "name"])
  if (existing.stdout.trim()) return yield* Effect.fail(new Error(`${worker.name} already exists. Refusing rejoin; never reset or delete a node automatically.`))
  yield* ssh(worker.address, workerPreflight(worker)).pipe(Effect.mapError(() => new Error("Worker preflight failed: check SSH trust, sudo, hostname/IP, containerd and existing join files. Do not reset or retry blindly.")))
  // Pin the token issuer to the same CA used by authenticated discovery.
  const digest = createHash("sha256").update(Buffer.from(ca, "base64")).digest("hex")
  const controlGuard = `set -euo pipefail
test "$(cat /proc/sys/kernel/hostname)" = "srv-lx-k8s-indigo-control-01"
test "$(sha256sum /etc/kubernetes/pki/ca.crt | cut -d ' ' -f 1)" = "${digest}"
`
  yield* ssh("10.10.80.100", controlGuard).pipe(Effect.mapError(() => new Error("Control-plane SSH/hostname/CA check failed; no token created.")))
  const sample = joinConfiguration(worker, "/run/schema-check", "abcdef.0123456789abcdef")
  sample.discovery.file.kubeConfigPath = "/dev/null"
  yield* io.run("ssh", [...sshOptions, `dsqr@${worker.address}`, "sudo -n kubeadm config validate --config /dev/stdin"], { input: JSON.stringify(sample), sensitive: true })
  if (!options.apply) {
    yield* Console.log(`${worker.name}: preflight and schema checks passed. No token created or join performed.`)
    return
  }
  yield* Console.log(`Joining ${worker.name} into the ${worker.pool} pool. Allow kubeadm to finish; do not interrupt.`)
  yield* Effect.acquireUseRelease(
    ssh("10.10.80.100", controlGuard + "kubeadm token create --ttl 30m --description indigo-worker-join\n").pipe(
      Effect.mapError(() => new Error("Token creation failed or response was lost. Stop; any issued token expires in 30 minutes.")),
      Effect.flatMap(result => {
        const token = result.stdout.trim()
        return /^[a-z0-9]{6}\.[a-z0-9]{16}$/.test(token)
          ? Effect.succeed(token)
          : Effect.fail(new Error("Unexpected token response. Stop; any issued token expires in 30 minutes."))
      }),
    ),
    token => ssh(worker.address, joinScript(worker, ca, token)).pipe(
      Effect.mapError(() => new Error("Join failed or SSH disconnected; inspect kubelet locally. Diagnostics suppressed to protect bootstrap credentials. Do not reset or retry blindly.")),
    ),
    token => ssh("10.10.80.100", controlGuard + `kubeadm token delete ${token.split(".")[0]}\n`).pipe(
      Effect.catchAll(() => Console.error("WARNING: token revocation failed; bootstrap token expires in 30 minutes. Check control-01 connectivity.")),
    ),
  )
  yield* kubectl(["wait", "--for=condition=Ready", `node/${worker.name}`, "--timeout=300s"], "310s").pipe(
    Effect.mapError(() => new Error("Join finished but readiness timed out. Stop and inspect; do not rejoin.")),
  )
  yield* Console.log(`${worker.name} joined and is Ready, with its pool label and dedicated taint. Run node-pools indigo --stage verify once the full inventory is onboarded.`)
})
