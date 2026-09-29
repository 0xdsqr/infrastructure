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
