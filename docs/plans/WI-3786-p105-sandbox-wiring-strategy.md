# WI-3786: P-105 Sandbox Wiring Strategy

**Rationale:** The P-105 sandbox module exists (58 unit tests pass) but is dormant — nothing in the live system calls it. This document captures the wiring strategy before implementation.

## Wiring Points

Based on the P-105 spec (DESIGN-p2p-P105-foreign-work-isolation-sandbox-spec-2026-07-02) and the recommended build sequence in BUILD-STATUS-p2p-P105-sandbox-2026-07-09.md:

### §3.1 Gateway Attribution (PURE — no privilege needed)
- **Where:** `packages/operator-core/lib/inference-gateway/gateway.ts` request handler
- **Function:** `decideGatewayAdmission`
- **Integration point:** Before forwarding request to Anthropic API
- **Status:** DEFERRED — requires credential store wiring (out of scope for v1, per spec)

### §3.2 PG Credential Isolation (PURE — filters env vars)
- **Where:** Foreign session spawn environment setup
- **Function:** `buildForeignProcessEnv`
- **Integration point:** When spawning foreign session, use this to filter the process environment
- **Current code:** WI-1937 doesn't wire this yet; spawns use the host env directly
- **Status:** READY TO WIRE — no privilege needed

### §3.3 Network Egress Filter (REAL — requires root + Linux + nft)
- **Where:** Session provisioning (early, after clone succeeds)
- **Function:** `applyNetnsPortFilter`
- **Integration point:** After provisioning foreign clone, create netns + load nft rules
- **Privilege requirement:** root + Linux + cgroup v2 + nftables
- **Status:** DEFERRED — skip on dev box without dedicated verification environment

### §4 Credential Isolation (REAL — requires root)
- **Where:** Session provisioning (can combine with §3.3)
- **Function:** `provisionIsolationPrincipal`
- **Integration point:** After provisioning foreign clone
- **Privilege requirement:** useradd or unshare (both need privilege)
- **Status:** DEFERRED — skip on dev box without dedicated verification environment

### §2 Compute Limits (MIXED — pure config + cgroup write)
- **Where:** Spawn + periodic supervision sweep
- **Functions:** `applyCgroupLimits` (real write) + `decideOverLimit` (pure decision)
- **Integration points:**
  - At spawn: apply cgroup limits via applyCgroupLimits
  - In supervision sweep: poll decideOverLimit, transition to winding-down if over
- **Status:** DEFERRED — cgroup v2 write needs root; skip on dev box

### §1 Quota Enforcement (PURE — disk walk, no privilege)
- **Where:** Foreign clone provision + periodic supervision sweep
- **Function:** `enforceForeignWorkspaceQuota`
- **Integration points:**
  - After clone succeeds: call enforceForeignWorkspaceQuota, fail if already over
  - In supervision sweep: poll enforceForeignWorkspaceQuota, transition to winding-down if over
- **Status:** READY TO WIRE — pure logic, no privilege needed

### §5 Enforcement Kill (MIXED — pure decision + SIGKILL)
- **Where:** Supervision sweep (wind-down processing)
- **Functions:** `decideEnforcedKill` (pure) + `killForeignSessionProcess` (needs privilege for cgroup)
- **Integration points:**
  - In supervision sweep: check if winding-down session has expired grace, decide whether to kill
  - Execute kill via SIGKILL (has fallback for non-cgroup path)
- **Status:** PARTIAL — can wire pure decision + SIGKILL fallback; cgroup-freeze skipped

## Implementation Phases

### Phase 1: PG Credential Isolation (§3.2) — READY
- Wire `buildForeignProcessEnv` into the spawn path
- Ensure foreign sessions don't inherit DATABASE_URL etc.
- Tests: verify env filtering works, no PG leaks

### Phase 2: Quota Enforcement (§1) — READY
- Wire `enforceForeignWorkspaceQuota` into `provisionForeignClone`
- Fail clone if workspace already over quota at provision time
- Add quota polling to foreign-supervision sweep
- Tests: verify quota enforcement, transition to winding-down when exceeded

### Phase 3: Enforcement Kill (§5) — PARTIAL
- Wire `decideEnforcedKill` into supervision sweep
- Execute kill via SIGKILL fallback (cgroup-freeze skipped)
- Tests: verify kill decision logic, SIGKILL execution

### Phase 4: Compute Limits (§2) — DEFERRED
- Requires cgroup v2 write (root privilege)
- Skip on dev box without dedicated environment

### Phase 5: Credential Isolation (§4) — DEFERRED
- Requires useradd or unshare (root privilege)
- Skip on dev box without dedicated environment

### Phase 6: Network Egress (§3.3) — DEFERRED
- Requires netns + nft (root + Linux)
- Skip on dev box without dedicated environment

### Phase 7: Gateway Attribution (§3.1) — DEFERRED
- Requires credential store wiring
- Out of scope for v1 per spec

## Verification Strategy

### Unit tests (existing)
- P-105 sandbox module has 58 passing tests
- Keep these passing, use them for sanity checks

### Integration tests (new)
- Test quota enforcement in foreign-clone.test.ts
- Test kill decision + SIGKILL execution in foreign-supervision.test.ts
- Test env filtering in offer-executor.test.ts

### E2E verification (on dedicated environment)
- The drill (packages/operator-core/lib/p2p/sandbox/drill.ts) can run full OS-privileged axes
- Run on root+Linux machine with cgroup v2 to verify netns/useradd/cgroup

### Live fleet impact
- Phases 1-3 are safe to land on shared dev box (no privilege needed)
- Phases 4-7 deferred to dedicated environment

## Risk Mitigation

1. **PG Credential Isolation (Phase 1):**
   - Risk: Breaking PG access for foreign sessions
   - Mitigation: The isolation is fail-closed (no PG if vars missing); test thoroughly

2. **Quota Enforcement (Phase 2):**
   - Risk: Rejecting valid work due to quota bug
   - Mitigation: Use the tested disk-walk logic; add safeguards for edge cases

3. **Enforcement Kill (Phase 3):**
   - Risk: Killing sessions prematurely
   - Mitigation: Kill only after grace expires + in winding-down state

4. **Deferred Privilege-Requiring Phases:**
   - Risk: Breaking network/credential isolation if implemented incorrectly
   - Mitigation: Don't implement these on shared dev box; require dedicated environment

## Checklist

- [ ] Phase 1: Wire buildForeignProcessEnv
- [ ] Phase 1: Tests pass (env filtering)
- [ ] Phase 2: Wire enforceForeignWorkspaceQuota in provision
- [ ] Phase 2: Wire quota polling in supervision
- [ ] Phase 2: Tests pass (quota enforcement)
- [ ] Phase 3: Wire decideEnforcedKill decision
- [ ] Phase 3: Wire killForeignSessionProcess (SIGKILL fallback)
- [ ] Phase 3: Tests pass (kill decision + execution)
- [ ] All existing tests pass (npm run test:affected)
- [ ] Document completion with evidence per work_items:complete
- [ ] Flag pending phases (4-7) for future work on dedicated environment
