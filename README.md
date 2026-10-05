<div align="center">

<h1>infrastructure</h1>

<p align="center">
  <a href="https://github.com/0xdsqr/infrastructure/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/0xdsqr/infrastructure/ci.yml?branch=master&style=for-the-badge&logo=github&label=check" alt="check"></a>
  <a href="https://github.com/0xdsqr/infrastructure/commits/master"><img src="https://img.shields.io/github/last-commit/0xdsqr/infrastructure?style=for-the-badge" alt="last commit"></a>
</p>

Declarative homelab infrastructure, cluster GitOps, and operational tooling.

</div>

## Indigo worker pools

Workers 01–03 are `platform`; 04–06 are `applications`. Pool membership is
declared in `packages/cluster/src/node-pools.ts`. Node objects are not Argo-owned
and must never be pruned. With Indigo's explicit `KUBECONFIG`, run:

```text
nix run .#cluster -- node-pools indigo --stage plan
nix run .#cluster -- node-pools indigo --stage labels
```

Label before syncing the Indigo placement templates. During initial bootstrap,
`labels` can run incrementally as workers register, before Cilium makes them Ready;
`reserve` still requires all six workers Ready. CoreDNS stays kubeadm-owned:
apply its `corednsdeployment-platform+strategic.yaml` patch from `nixos-config`,
and deploy that repository's control-plane configuration to preserve it on upgrades.
After all rollouts finish, `--stage reserve` adds each pool's matching
`platform.dsqr.dev/dedicated=<pool>:NoSchedule` taint only after checking placement,
tolerations and readiness; `--stage verify` is read-only. The application pool is
held empty except for Cilium, Cilium Envoy and MetalLB speaker node agents. The
gate rejects other running Pods there. During future application onboarding,
update that empty-pool check and explicitly pair required application-pool
selection with its matching toleration. Taints are scheduler controls, not an
authorization boundary against workloads allowed to set tolerations or nodeName.
Rerun this sequence after replacing/joining workers. Update the explicit
inventory and expected node-agent counts when expanding. These commands never
drain nodes, delete workloads or touch Tailscale/SSH configuration.

## Joining a new or deliberately replaced Indigo worker

Provision its VM and NixOS configuration first, establish trusted SSH host keys,
and ensure your key has non-interactive sudo on the worker and control-01.
Use the explicit Indigo `KUBECONFIG`, then run one worker at a time:

```text
nix run .#cluster -- join-worker indigo --worker 04 --identity /absolute/path/to/ssh-key --check-only
nix run .#cluster -- join-worker indigo --worker 04 --identity /absolute/path/to/ssh-key --apply
```

The command uses the declared worker inventory, verifies the API endpoint and CA,
checks hostname/IP and containerd, validates the join schema, and refuses existing
Node objects or partial join files. It never resets or deletes Nodes. It registers
the declared pool label and dedicated taint, preserves NixOS kubeadm patches, and
waits for Ready. Application-pool workers remain reserved for explicit onboarding.
The check-only mode creates no bootstrap token and performs no join; it is intended
for **unjoined** hosts, not an audit command for existing workers.

Bootstrap credentials travel over SSH stdin, not command arguments or workstation
files. The root-only remote files live under `/run` and are removed on exit. Token
revocation is attempted on success, failure and interruption; a 30-minute TTL is
the fallback for a lost connection or killed client. Sensitive SSH diagnostics are
suppressed. If anything fails, inspect the node before retrying—do not reset it.
After onboarding, run `node-pools indigo --stage verify`. Future nodes require an
explicit inventory change first; the current inventory is workers 01–06.

## New-homelab core monitoring (Phase 9, in progress)

Reuse Beacon's NixOS-managed Grafana, Prometheus/Mimir, Loki, Tempo, Pyroscope,
and Alloy. Scope new collection and dashboards to Indigo and its supporting
core infrastructure; do not change or delete hub-a collection, dashboards, or data.
Dashboard JSON and backend configuration belong in `nixos-config` under
`hosts/srv-lx-beacon`; Kubernetes collectors and scrape permissions belong here
in GitOps. Vault issuance policy belongs in this repository's Vault stack.

Initial dashboard titles are `Infra - Homelab - Overview`,
`K8s - Indigo - Overview`, and `K8s - Indigo - Argo CD`. Use stable dashboard
UIDs, explicit inventory/cluster filters, and distinguish missing telemetry from
healthy zero values. Retain source metric names; normalize identity labels without
copying arbitrary Kubernetes labels. Expected manual-sync drift must not page like
a failed reconciliation. Discord is the chosen destination, but notification
delivery and its end-to-end test remain deferred—not completed.

Rollout order: 9A inventory/standards and secure transport; 9B node/cluster metrics;
9C core-service coverage; 9D dashboards; 9E alert rules (delivery deferred);
9F non-DNS coverage and recovery validation; 9G DNS monitoring and its final
validation (last setup step, explicitly deferred on October 5). Beacon's dedicated TLS issuance role and
certificate enrollment are deployed; certificate expiry metrics are being scraped.
The NixOS ingestion listener is prepared on TCP 9443 with required client TLS,
an explicit Indigo collector identity, write-only metrics/logs/traces routes, and
forced certificate reload. Local positive/negative TLS and reload tests pass.
First listener activation exposed a permission-readiness race; the listener was
started successfully after rendering completed. The ownership/mode readiness fix
has since been rebuilt and verified on Beacon. Existing services remain running.
A client-only Indigo telemetry issuance role was applied and verified in Vault
on October 5: one exact DNS identity and one issuer service account in
`observability`, using the existing `kubernetes-indigo` authentication boundary.
Leaf keys are not Pulumi resources. GitOps certificate preparation is implemented;
live issuance remains unverified: a restricted, default-deny `observability` namespace,
dedicated issuer identity, independent root CA bundle, and an ExternalSecret that
reissues a 30-day client certificate every 10 days. No collectors are added yet.
These configuration applications auto-sync after a push; they may wait for the
bootstrap AppProject permissions to be updated. Update those permissions, then
reconcile `cluster-foundation` and `argocd-config` before
`external-secrets-config`. Verify successful issuance without printing the private
key. Collector mounts and certificate reload handling, live renewal validation,
DNS monitoring, and end-to-end canary ingestion remain pending. Also review the
certificate's unreachable OCSP URL before transport sign-off. Existing ingestion
stays unchanged.

Include OPNsense firewall/system logs in 9C. Defer DNS visibility (Unbound and
CoreDNS) to 9G, after the other core monitoring setup. Start with resolver
availability, errors, latency, cache/response statistics
where available; full DNS query logging needs an explicit privacy/volume choice.
On September 30, both OPNsense metric exporters were up, but no Unbound/DNS metric
names were found in the Telegraf scrape. No OPNsense log entries were present in
the configured Loki stream over the preceding 24 hours. Alloy reported healthy
syslog components with empty listener lists; validated configuration reload did
not recover them. Restarting only Alloy restored TCP 1514 (OPNsense) and 1515
(Proxmox). The original failure cause and boot-time listener readiness still need
validation; service health alone is not evidence of log ingestion. These existing
syslog receivers are not covered by the new HTTPS/mTLS listener. Verify OPNsense's
logging target, format, source address, and actual log arrival before sign-off.
The scoped OPNsense logging API now works with connection-local Cloudflare Origin
CA trust and explicit management-IP routing (the hostname does not resolve in the
CLI environment). Its Beacon target is enabled with TCP/RFC5424. A header-only
capture confirmed source `10.10.30.1` while Beacon allowed only `10.10.10.1` on
TCP 1514. The corrected Nix rule allows only `ens18`, source `10.10.30.1`,
destination `10.10.30.102`, TCP 1514. The Beacon rebuild and live ingestion were
verified on September 30: the connection was established and firewall/system
logs reached Loki with no observed receiver parsing errors. Its second logging destination,
`10.10.30.30:1514`, remains untouched until its ownership is confirmed.

Unbound's API statistics were available, but enabling Telegraf's Unbound input
produced repeated `unbound-control ... stats_noreset` exit-status-1 errors and no
Unbound metrics in Prometheus. The underlying cause remains unconfirmed; this
does not establish a DNS outage. On October 5, only that metrics input was
disabled and Telegraf reconfigured while monitoring is deferred; both Telegraf
and Unbound reported running afterward. DNS settings and query logging were
unchanged. Resume 9G by obtaining the underlying collector command error through
an authorized diagnostic path, then validate collection, dashboards, and alerts.
SSH/account setup for this diagnostic is paused, not a prerequisite for the
remaining non-DNS monitoring work.
