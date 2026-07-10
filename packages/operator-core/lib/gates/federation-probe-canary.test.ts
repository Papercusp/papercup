/**
 * federation-probe-canary.test.ts (fleet-reliability-verification-2026-07-10
 * P-011). Deps injected — no PG, no MCP layer; proves the canary itself
 * correctly reads stampProbe's refusal vs success and the insertProbe failure
 * leg, independent of runGateCanary's classification (covered in canary.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { buildFederationProbeCanary } from './federation-probe-canary';

const baseDeps = () => ({
  workspaceId: 'ws-1',
  harnessSlug: 'my-hive',
  emittedBy: 'su-agent',
  harnessIsFederated: vi.fn(async () => true),
  insertProbe: vi.fn(async () => ({})),
  nowMs: () => 1_700_000_000_000,
});

describe('buildFederationProbeCanary', () => {
  it('id + describe embed the harness slug', () => {
    const canary = buildFederationProbeCanary(baseDeps());
    expect(canary.id).toBe('federation-probe:my-hive');
    expect(canary.describe).toContain('my-hive');
  });

  it('a federated harness stamps + persists cleanly → ok:true', async () => {
    const deps = baseDeps();
    const canary = buildFederationProbeCanary(deps);
    const result = await canary.run();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('stamped + persisted cleanly');
    expect(deps.insertProbe).toHaveBeenCalledTimes(1);
    const stamped = deps.insertProbe.mock.calls[0][0];
    expect(stamped).toMatchObject({ workspaceId: 'ws-1', harnessSlug: 'my-hive', emittedBy: 'su-agent' });
  });

  it('an UNFEDERATED harness REFUSES (stampProbe) → ok:false, never calls insertProbe (the cause-#10 class)', async () => {
    const deps = baseDeps();
    deps.harnessIsFederated = vi.fn(async () => false);
    const canary = buildFederationProbeCanary(deps);
    const result = await canary.run();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('harness_not_federated');
    expect(deps.insertProbe).not.toHaveBeenCalled();
  });

  it('the federation-lookup itself throwing is caught → ok:false, never calls insertProbe', async () => {
    const deps = baseDeps();
    deps.harnessIsFederated = vi.fn(async () => {
      throw new Error('registry down');
    });
    const canary = buildFederationProbeCanary(deps);
    const result = await canary.run();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('registry down');
    expect(deps.insertProbe).not.toHaveBeenCalled();
  });

  it('a stamped probe that fails to PERSIST → ok:false (the apparatus is broken past stamping)', async () => {
    const deps = baseDeps();
    deps.insertProbe = vi.fn(async () => {
      throw new Error('pg down');
    });
    const canary = buildFederationProbeCanary(deps);
    const result = await canary.run();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('persistence failed');
    expect(result.detail).toContain('pg down');
  });
});
