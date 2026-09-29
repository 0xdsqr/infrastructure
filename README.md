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
After all rollouts finish, `--stage reserve` adds the platform `NoSchedule` taint
only after checking placement, tolerations and readiness; `--stage verify` is
read-only. Rerun this sequence after replacing/joining workers. Update the explicit
inventory and expected node-agent counts when expanding. These commands never
drain nodes, delete workloads or touch Tailscale/SSH configuration.
