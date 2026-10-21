# Infrastructure migration follow ups

## Phase 12 — DSQR and Tastings with Tay migration

### Deferred subphase — Redis and Dotdev high availability

Status: deferred until after initial application onboarding.
This extends the existing Phase 12 infrastructure work; phases 13–19 retain
their existing numbering. This file records the follow-up, not the full roadmap.

Goal: run three Dotdev replicas across the application workers with shared rate
limits. Keep Dotdev at one steady-state replica with its current Helm guard until the following
steps are complete.

- [ ] Provision Redis for application rate limiting through IaC/GitOps. Review
  availability, authentication, TLS, resource limits and monitoring; scope network
  access to the consuming application and keep credentials in Vault/ESO.
- [ ] In `dsqr-dotdev`, replace process-local global, client-IP and email limits
  with shared atomic counters and expiry. Define backend-outage behavior explicitly;
  do not silently fall back to independent per-process limits.
- [ ] Verify trusted client-IP handling through Cloudflare and Envoy, including
  protection against spoofed forwarded headers.
- [ ] Test concurrent requests across replicas, expiry, restarts and Redis outages.
- [ ] Once verified, update Dotdev's Helm replica guard, rollout strategy and checks;
  deploy three replicas across the application workers and verify traffic and
  disruption behavior. Database availability remains a separate dependency.

Completion criteria: all steps checked, shared limits verified across all three
replicas, and a single-worker disruption tested successfully. This does not claim
physical-host resilience when workers share a hypervisor.
