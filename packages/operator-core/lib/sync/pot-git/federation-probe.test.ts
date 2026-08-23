import { describe, expect, it } from 'vitest';
import { buildProbeKey, PROBE_HOPS, stampProbe } from './federation-probe';

describe('stampProbe', () => {
  const base = {
    workspaceId: 'ws-1',
    harnessSlug: 'papercusp',
    emittedBy: 'su-abc123',
    harnessIsFederated: true,
    nowMs: 1_000_000,
  };

  it('stamps a valid probe with all required federation keys', () => {
    const result = stampProbe(base);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.stamped.workspaceId).toBe('ws-1');
    expect(result.stamped.harnessSlug).toBe('papercusp');
    expect(result.stamped.emittedBy).toBe('su-abc123');
    expect(result.stamped.emittedAtMs).toBe(1_000_000);
    expect(result.stamped.probeKey).toContain('papercusp:v2t:');
    expect(result.stamped.probeKey).toContain('su-abc123');
  });

  it('refuses loudly (never silently) when workspaceId is missing', () => {
    expect(stampProbe({ ...base, workspaceId: null })).toMatchObject({
      ok: false,
      reason: 'missing_workspace',
    });
  });

  it('refuses when workspaceId is the "*" scope selector', () => {
    expect(stampProbe({ ...base, workspaceId: '*' })).toMatchObject({
      ok: false,
      reason: 'missing_workspace',
    });
  });

  it('refuses when harnessSlug is missing (the exact cause-#10 defect)', () => {
    expect(stampProbe({ ...base, harnessSlug: '' })).toMatchObject({
      ok: false,
      reason: 'missing_harness_slug',
    });
  });

  it('refuses when harnessSlug is the "*" scope selector', () => {
    expect(stampProbe({ ...base, harnessSlug: '*' })).toMatchObject({
      ok: false,
      reason: 'invalid_harness_slug',
    });
  });

  it('refuses when emittedBy cannot be resolved', () => {
    expect(stampProbe({ ...base, emittedBy: undefined })).toMatchObject({
      ok: false,
      reason: 'missing_emitted_by',
    });
  });

  it('refuses an unfederated harness loudly instead of emitting a doomed probe', () => {
    const result = stampProbe({ ...base, harnessIsFederated: false });
    expect(result).toMatchObject({ ok: false, reason: 'harness_not_federated' });
    if (result.ok) throw new Error('expected refusal');
    expect(result.detail).toMatch(/federation\/registry entry/);
  });
});

describe('buildProbeKey', () => {
  it('is direction-unique across calls (never reuses a name, per the runbook rule)', () => {
    const rand = (() => {
      let n = 0;
      return () => {
        n += 1;
        return (n % 97) / 97;
      };
    })();
    const a = buildProbeKey('papercusp', 'su-1', 1000, rand);
    const b = buildProbeKey('papercusp', 'su-1', 1000, rand);
    expect(a).not.toBe(b);
  });

  it('embeds the harness slug and emitter for at-a-glance attribution', () => {
    const key = buildProbeKey('p2p-git', 'su-9eb0c', 42, () => 0.5);
    expect(key.startsWith('p2p-git:v2t:')).toBe(true);
    expect(key).toContain('su-9eb0c');
  });
});

describe('captured-only receipt contract (WI-3962)', () => {
  it('declares no synthetic post-capture hops', () => {
    expect(PROBE_HOPS).toEqual(['captured']);
  });
});
