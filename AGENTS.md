# Infrastructure Agent Notes

## Repository Direction

- This repository owns Pulumi-backed infrastructure, cluster GitOps state, and operational tooling.
- Keep the workspace Nix-first. Checks and operator commands must be exposed through the flake.
- Preserve live Pulumi project names, stack identities, resource logical names, and parent relationships.
- Never run `pulumi up`, `pulumi destroy`, state imports, host rebuilds, or live Kubernetes mutations without explicit approval.

## Layout

- `infra.config.ts` is the single static stack registry.
- `infra/*` contains provider programs and configuration.
- `packages/{core,cli,model}` contains orchestration and domain code.
- `packages/pulumi/*` contains Effect-backed provider adapters.
- `gitops/*` contains Argo CD desired state and values; application charts remain in their application repositories.
- `tools/*` contains operator and migration utilities.
- `nix/*` contains packages, checks, scripts, and the development shell.

## Engineering Style

- Prefer small, typed Effect programs for non-UI orchestration.
- Wrap Promise APIs with `Effect.tryPromise` and use typed errors at shared boundaries.
- Keep TypeScript executable by Node's native type stripping: no enums, namespaces, parameter properties, or runtime path aliases.
- Pin dependencies and GitHub Actions exactly.
- Keep pure checks credential-free. Live Pulumi previews are explicit operator actions.
- Add deterministic tests for state transformations and security boundaries.

## Safety

- Preview before every live infrastructure change.
- Treat creates, deletes, replacements, and unexpected refresh differences as stop conditions.
- State migration tools must write a separate output and must never import automatically.
- Pulumi state exports used by migration tools must end in `.pulumi-state.json`; Git and Nix exclude that convention.
- Protect adopted storage and other irreplaceable resources with both `protect` and `retainOnDelete`.
- Do not remove the legacy source tree until all six migrated stacks and the Argo CD cutover have been accepted.
