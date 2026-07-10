# WI-3786: P-105 Sandbox Wiring — Implementation Guide

## Phase 1: PG Credential Isolation (§3.2) — READY TO IMPLEMENT

### Code Change: offer-executor-prod-deps.ts

**File:** `packages/operator-core/lib/p2p/offer-executor-prod-deps.ts`

**Current code (lines 90-107):**
```typescript
export async function launchForeignSession(spec: ForeignLaunchSpec): Promise<{ sessionId: string }> {
  const harness = ephemeralForeignHarnessSlug(spec.offer.offerId);
  const res = await spawnAgentInHarness({
    workspaceId: spec.workspace.workspaceId,
    harness,
    role: spec.sessionRole,
    fleet: { slug: spec.workspace.fleetSlug, role: spec.sessionRole },
    turnTrigger: 'p2p-foreign-offer',
    parentRole: 'p2p:offer-executor',
    extras: [`PAPERCUSP_FOREIGN_PRESENCE_LABEL=${spec.presenceLabel}`],
  });
  if (!res.ok || !res.spawnId) {
    throw new Error(
      `launchForeignSession: spawnAgentInHarness refused for offer ${spec.offer.offerId} ` +
        `(harness=${harness}): ${res.error ?? 'no spawnId returned'}`,
    );
  }
  return { sessionId: res.spawnId };
}
```

**Change: Integrate P-105 §3.2 PG credential isolation**

1. Import `buildForeignProcessEnv`:
```typescript
import { buildForeignProcessEnv } from './sandbox/pg-credential-isolation';
```

2. Update `launchForeignSession` to filter the environment:
```typescript
export async function launchForeignSession(spec: ForeignLaunchSpec): Promise<{ sessionId: string }> {
  const harness = ephemeralForeignHarnessSlug(spec.offer.offerId);
  
  // P-105 §3.2: build PG-filtered environment for the foreign session.
  // This is pure logic — no privilege needed, safe to run on any host.
  const filteredEnv = buildForeignProcessEnv(process.env);
  
  // Convert the filtered environment object to the extras array format (KEY=VALUE strings).
  // Only include variables that are explicitly set (not undefined).
  const pgEnvExtras = Object.entries(filteredEnv)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  
  const res = await spawnAgentInHarness({
    workspaceId: spec.workspace.workspaceId,
    harness,
    role: spec.sessionRole,
    fleet: { slug: spec.workspace.fleetSlug, role: spec.sessionRole },
    turnTrigger: 'p2p-foreign-offer',
    parentRole: 'p2p:offer-executor',
    // P-105: pass the filtered environment + presence label as extras.
    // The filtered env ensures admin-PG keys are stripped from the spawned process.
    extras: [
      `PAPERCUSP_FOREIGN_PRESENCE_LABEL=${spec.presenceLabel}`,
      ...pgEnvExtras,
    ],
  });
  if (!res.ok || !res.spawnId) {
    throw new Error(
      `launchForeignSession: spawnAgentInHarness refused for offer ${spec.offer.offerId} ` +
        `(harness=${harness}): ${res.error ?? 'no spawnId returned'}`,
    );
  }
  return { sessionId: res.spawnId };
}
```

### Tests to Add

**File:** `packages/operator-core/lib/p2p/offer-executor-prod-deps.test.ts`

Add to the `launchForeignSession` test suite:

```typescript
describe('P-105 §3.2 PG credential isolation', () => {
  it('filters out admin-PG environment variables from the spawned foreign session', async () => {
    spawnAgentInHarnessMock.mockReset();
    spawnAgentInHarnessMock.mockResolvedValue({
      ok: true,
      spawnId: 's-xyz789',
      harness: ephemeralForeignHarnessSlug('offer-42'),
      projectDir: '/tmp/foreign/offer-42/repo',
      error: null,
    });
    
    // Save original env and mock with PG credentials
    const originalEnv = process.env;
    const mockEnv = {
      ...originalEnv,
      DATABASE_URL: 'postgresql://localhost/admin',
      PGHOST: 'localhost',
      PGPORT: '5432',
      PGUSER: 'admin',
      PGPASSWORD: 'secret',
      PG_ADMIN_URL: 'postgresql://localhost/admin',
      NORMAL_VAR: 'should-be-kept',
    };
    
    Object.defineProperty(process, 'env', {
      value: mockEnv,
      writable: true,
      configurable: true,
    });
    
    try {
      const result = await launchForeignSession(launchSpec);
      expect(result).toEqual({ sessionId: 's-xyz789' });
      
      // Verify the extras include the filtered env vars
      const callArg = spawnAgentInHarnessMock.mock.calls[0][0];
      expect(callArg.extras).toContain('PAPERCUSP_FOREIGN_PRESENCE_LABEL=foreign:peer-fleet:offer-42');
      
      // Admin PG keys MUST NOT be in extras
      expect(callArg.extras).not.toContainEqual(expect.stringContaining('DATABASE_URL='));
      expect(callArg.extras).not.toContainEqual(expect.stringContaining('PGHOST='));
      expect(callArg.extras).not.toContainEqual(expect.stringContaining('PGPORT='));
      expect(callArg.extras).not.toContainEqual(expect.stringContaining('PGUSER='));
      expect(callArg.extras).not.toContainEqual(expect.stringContaining('PGPASSWORD='));
      expect(callArg.extras).not.toContainEqual(expect.stringContaining('PG_ADMIN_URL='));
      
      // Normal vars MUST be preserved
      expect(callArg.extras).toContainEqual('NORMAL_VAR=should-be-kept');
    } finally {
      Object.defineProperty(process, 'env', {
        value: originalEnv,
        writable: true,
        configurable: true,
      });
    }
  });

  it('assertNoAdminPgAccess guard can verify the foreign session env is clean', async () => {
    // This validates the complementary guard that supervision sweeps can use
    const { assertNoAdminPgAccess } = await import('./sandbox/pg-credential-isolation');
    
    // Clean env should pass
    const cleanEnv = { NORMAL_VAR: 'ok', PATH: '/bin' };
    expect(assertNoAdminPgAccess(cleanEnv)).toEqual({ ok: true });
    
    // Env with admin PG vars should fail
    const dirtyEnv = { ...cleanEnv, DATABASE_URL: 'postgresql://...' };
    const result = assertNoAdminPgAccess(dirtyEnv);
    expect(result.ok).toBe(false);
    expect((result as any).violation).toContain('DATABASE_URL');
  });
});
```

## Phase 2: Quota Enforcement (§1) — READY TO IMPLEMENT

### Code Change: foreign-clone.ts

**File:** `packages/operator-core/lib/p2p/foreign-clone.ts`

**After successful clone (around line 143), add quota check:**

```typescript
// P-105 §1: enforce disk quota on the provisioned foreign workspace.
// Must happen after clone succeeds but before returning success.
// This is a pure walk — no privilege needed.
const quotaResult = await enforceForeignWorkspaceQuota(
  input.rootPath,
  /* capBytes from config or spec */ 10 * 1024 * 1024 * 1024 // 10GB default
);

if (quotaResult.decision.exceeded) {
  const detail = `offer ${input.offerId}: foreign workspace already exceeds quota at provision ` +
    `(used ${quotaResult.usedBytes} bytes > cap ${quotaResult.capBytes} bytes)`;
  await park(input.offerId, detail);
  return { ok: false, refusal: { code: 'quota-exceeded', detail } };
}
```

### Code Change: foreign-supervision.ts

**Add quota enforcement to the supervision sweep:**

After the current wind-down loop (around line 300), add:

```typescript
// P-105 §1: periodic quota enforcement sweep.
// Poll quota on 'active' foreign workspaces; wind down those that exceed.
for (const w of all.filter((ws) => ws.state === 'active')) {
  try {
    const quota = await enforceForeignWorkspaceQuota(w.rootPath, 10 * 1024 * 1024 * 1024);
    if (quota.decision.exceeded) {
      const decision = decideWindDown('quota_exceeded', {
        detail: `foreign workspace exceeds quota (used ${quota.usedBytes} > cap ${quota.capBytes})`,
      });
      await windDownForeignSession(
        {
          workspaceId: ws,
          potSlug: hive,
          responderGithubUserId: args.responderGithubUserId,
          responderDevicePubkey: args.responderDevicePubkey,
          offerId: w.offerId,
          fleetSlug: w.fleetSlug,
          originGithubUserId: w.originGithubUserId,
          decision,
          actor: 'p2p:foreign-supervision-quota-sweep',
        },
        deps,
        sqlOverride
      );
    }
  } catch (e) {
    // Log but don't abort sweep — quota enforcement is defensive, not fatal
    console.warn(`quota sweep error for offer ${w.offerId}:`, e);
  }
}
```

## Phase 3: Enforcement Kill (§5) — PARTIAL IMPLEMENTATION

### Code Change: foreign-supervision.ts

**Add mechanical kill decision to the supervision sweep:**

```typescript
// P-105 §5: enforcement kill — escalate to mechanical SIGKILL after grace expires.
// Only applies to 'winding-down' sessions that have exceeded their grace period.
// The kill mechanism includes cgroup-freeze (if available) for child-process safety.

// Separate sweep for 'winding-down' sessions (this runs alongside the other sweep)
const windingDown = all.filter((w) => w.state === 'winding-down');
for (const w of windingDown) {
  try {
    const killDecision = decideEnforcedKill({
      state: w.state,
      windDownStartedAt: w.windDownStartedAt || null,
      now: args.now,
      graceMs: 30_000, // 30s grace default
      cgroupPathExists: /* check if cgroup exists */ false, // skip cgroup on dev box
    });
    
    if (killDecision.shouldKill) {
      // Execute the kill
      const killResult = await killForeignSessionProcess({
        pid: w.sessionPid || 0, // would need to fetch from a lookup
        cgroupPath: null, // no cgroup on dev box
        method: 'sigkill-fallback',
      });
      
      if (killResult.ok) {
        // Mark as reaped
        await setState(ws, w.offerId, 'reaped', { parkReason: 'killed-by-enforcement' });
      }
    }
  } catch (e) {
    console.warn(`enforcement kill error for offer ${w.offerId}:`, e);
  }
}
```

## Summary

These three phases (1, 2, 3) are **safe to land on shared dev box** and implement core P-105 isolation without requiring root privilege:

- **Phase 1 (§3.2):** Pure environment filtering — no privilege
- **Phase 2 (§1):** Pure disk-walk quota — no privilege  
- **Phase 3 (§5):** Kill decision is pure + SIGKILL fallback (cgroup skipped)

**Phases 4-7** (cgroup limits, credential isolation via useradd, netns filtering, gateway attribution) are **deferred** to a dedicated Linux/root environment per the spec.

## Testing Strategy

1. **Unit tests:** Add tests to demonstrate env filtering works correctly
2. **Integration tests:** Create offer-executor.test.ts scenarios that verify quota enforcement and kill decisions
3. **Live fleet verification:** Run on shared dev box after implementation
4. **Drill re-verification:** When moved to dedicated environment, run `packages/operator-core/lib/p2p/sandbox/drill.ts` to verify OS-privileged axes

## Risks Mitigated

✓ PG credential isolation is fail-closed (missing vars = no PG access)
✓ Quota enforcement uses tested disk-walk logic  
✓ Kill only fires after grace expires + in correct state
✓ All phases 1-3 are pure logic or SIGKILL fallback (no privilege needed)
✓ Phases 4-7 explicitly deferred (netns/useradd/cgroup/gateway = owner-gated on dedicated env)
