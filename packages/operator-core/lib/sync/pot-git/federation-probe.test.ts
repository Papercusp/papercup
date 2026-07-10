import { describe, expect, it } from 'vitest';
import {
  buildProbeKey,
  deriveProbeVerdict,
  formatProbeVerdict,
  PROBE_HOPS,
  stampProbe,
  type ProbeReceipt,
} from './federation-probe';

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
    // the stamped key itself carries the harness + emitter — never opaque.
    expect(result.stamped.probeKey).toContain('papercusp:v2t:');
    expect(result.stamped.probeKey).toContain('su-abc123');
  });

  it('refuses loudly (never silently) when workspaceId is missing', () => {
    const result = stampProbe({ ...base, workspaceId: null });
    expect(result).toMatchObject({ ok: false, reason: 'missing_workspace' });
  });

  it('refuses when workspaceId is the "*" scope selector', () => {
    const result = stampProbe({ ...base, workspaceId: '*' });
    expect(result).toMatchObject({ ok: false, reason: 'missing_workspace' });
  });

  it('refuses when harnessSlug is missing (the exact cause-#10 defect)', () => {
    const result = stampProbe({ ...base, harnessSlug: '' });
    expect(result).toMatchObject({ ok: false, reason: 'missing_harness_slug' });
  });

  it('refuses when harnessSlug is the "*" scope selector', () => {
    const result = stampProbe({ ...base, harnessSlug: '*' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_harness_slug' });
  });

  it('refuses when emittedBy cannot be resolved', () => {
    const result = stampProbe({ ...base, emittedBy: undefined });
    expect(result).toMatchObject({ ok: false, reason: 'missing_emitted_by' });
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

describe('deriveProbeVerdict', () => {
  function receipt(overrides: Partial<ProbeReceipt> = {}): ProbeReceipt {
    return {
      probeKey: 'papercusp:v2t:x-su-1-abc',
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      emittedBy: 'su-1',
      emittedAtMs: 0,
      status: 'pending',
      hops: {},
      ...overrides,
    };
  }

  it('reports refused verdicts verbatim, never inferring a hop', () => {
    const r = receipt({ status: 'refused', refusalReason: 'harness_not_federated' });
    const v = deriveProbeVerdict(r, { nowMs: 10_000 });
    expect(v.verdict).toBe('refused');
    expect(v.lastHopReached).toBeNull();
    expect(v.stalledAtHop).toBeNull();
  });

  it('acks once every expected hop has landed', () => {
    const r = receipt({
      hops: { captured: 100, drained: 200, replicated: 300, merged: 400, memberGuard: 500, projected: 600 },
    });
    const v = deriveProbeVerdict(r, { nowMs: 1000 });
    expect(v.verdict).toBe('acked');
    expect(v.lastHopReached).toBe('projected');
  });

  it('acks against a NARROWED expected-hop list (local-only probe, no live peer)', () => {
    const r = receipt({ hops: { captured: 100, drained: 200 } });
    const v = deriveProbeVerdict(r, { nowMs: 1000, expectedHops: ['captured', 'drained'] });
    expect(v.verdict).toBe('acked');
  });

  it('reads pending within grace when the next hop has not landed yet', () => {
    const r = receipt({ hops: { captured: 900_000 } });
    const v = deriveProbeVerdict(r, { nowMs: 960_000, staleAfterMs: 180_000 });
    expect(v.verdict).toBe('pending');
    expect(v.lastHopReached).toBe('captured');
    expect(v.stalledAtHop).toBeNull();
  });

  it('NAMES the exact stalled hop once past grace (the P-010 requirement)', () => {
    const r = receipt({ hops: { captured: 100, drained: 200, replicated: 300 } });
    const v = deriveProbeVerdict(r, { nowMs: 1_000_000, staleAfterMs: 180_000 });
    expect(v.verdict).toBe('stalled');
    expect(v.lastHopReached).toBe('replicated');
    expect(v.stalledAtHop).toBe('merged');
    expect(v.detail).toContain("stalled at 'merged'");
  });

  it('names capture itself as the stalled hop when nothing has landed at all', () => {
    const r = receipt({ hops: {} });
    const v = deriveProbeVerdict(r, { nowMs: 1_000_000, staleAfterMs: 180_000 });
    expect(v.verdict).toBe('stalled');
    expect(v.lastHopReached).toBeNull();
    expect(v.stalledAtHop).toBe('captured');
  });

  it('walks hops in the canonical pipeline order', () => {
    expect(PROBE_HOPS).toEqual(['captured', 'drained', 'replicated', 'merged', 'memberGuard', 'projected']);
  });
});

describe('formatProbeVerdict', () => {
  it('renders a loud one-liner naming harness + verdict + detail', () => {
    const r: ProbeReceipt = {
      probeKey: 'papercusp:v2t:x-su-1-abc',
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      emittedBy: 'su-1',
      emittedAtMs: 0,
      status: 'pending',
      hops: { captured: 100 },
    };
    const v = deriveProbeVerdict(r, { nowMs: 1_000_000, staleAfterMs: 180_000 });
    const line = formatProbeVerdict(r, v);
    expect(line).toContain('papercusp:v2t:x-su-1-abc');
    expect(line).toContain('[papercusp]');
    expect(line).toContain('stalled');
  });
});
