import { describe, expect, it } from 'vitest';
import { DEFAULT_DELEGATED_SEAT_POLICY, evaluateDelegatedSeatPolicy, loadDelegatedSeatPolicy } from './delegated-seat-policy';

const base = {
  policy: DEFAULT_DELEGATED_SEAT_POLICY,
  workspaceId: 'ws-1',
  credentialRoute: 'default' as const,
  requestedSeats: 1,
  activeSeats: 0,
  requestedAtMs: 1_000,
  nowMs: 2_000,
};

describe('delegated seat policy (P-516/F5)', () => {
  it('labels the default path as trusted host-agent delegation and exposes stop/spend semantics', () => {
    const result = evaluateDelegatedSeatPolicy(base);
    expect(result).toEqual({
      ok: true,
      audit: {
        trustLabel: 'trusted-host-agent-delegation',
        sandbox: 'host-agent-envelope',
        spendVisibility: 'unmetered-v1',
        stopControl: 'resource:delegate remove + fleet stop',
      },
    });
  });

  it('refuses an untrusted public mode instead of pretending the host envelope is a sandbox', () => {
    const result = evaluateDelegatedSeatPolicy({ ...base, policy: { ...DEFAULT_DELEGATED_SEAT_POLICY, trustMode: 'untrusted-public' } });
    expect(result).toMatchObject({ ok: false, code: 'untrusted_public_requires_os_sandbox' });
  });

  it('enforces workspace, credential, concurrency, duration, and spend ceilings', () => {
    const policy = { ...DEFAULT_DELEGATED_SEAT_POLICY, allowedWorkspaceIds: ['allowed'], allowedCredentialRoutes: ['pinned'] as const, maxConcurrentSeats: 2, maxDurationMs: 100, maxSpendMicros: 5 };
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'ws-1' })).toMatchObject({ code: 'workspace_not_allowed' });
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'allowed', credentialRoute: 'default' })).toMatchObject({ code: 'credential_route_not_allowed' });
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'allowed', credentialRoute: 'pinned', activeSeats: 2 })).toMatchObject({ code: 'delegated_concurrency_cap' });
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'allowed', credentialRoute: 'pinned', nowMs: 2_000 })).toMatchObject({ code: 'delegated_duration_cap' });
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'allowed', credentialRoute: 'pinned', requestedAtMs: 2_000, nowMs: 2_050 })).toMatchObject({ code: 'spend_estimate_unavailable' });
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'allowed', credentialRoute: 'pinned', requestedAtMs: 2_000, nowMs: 2_050, estimatedSpendMicros: 6 })).toMatchObject({ code: 'delegated_spend_cap' });
  });

  it('fails closed on malformed host policy overrides', () => {
    expect(loadDelegatedSeatPolicy({ PAPERCUSP_DELEGATED_SEAT_POLICY: '{"maxConcurrentSeats":0}' })).toMatchObject({ ok: false, code: 'delegated_seat_policy_invalid' });
    expect(loadDelegatedSeatPolicy({})).toEqual({ ok: true, policy: DEFAULT_DELEGATED_SEAT_POLICY });
  });
});
