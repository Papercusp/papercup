/**
 * sentinel-context tests — the pure scope-LABEL helper + the renderer's heading
 * scoping (plan workspace-scoped-coordination-2026-06-20, P-006 / D-008).
 *
 * The Sentinel summary's digest legs are already workspace-wide (D-008); the only
 * Sentinel-owned gap was the heading mislabeling a workspace-wide summary as one
 * arbitrary harness. These tests pin the flag-gated label selection (OFF =
 * byte-identical to the per-hive label) and that the deterministic renderer
 * surfaces whatever scope label it is given.
 */
import { describe, it, expect } from 'vitest';
import { sentinelScopeLabel, renderSentinelContext, gatherSentinelContext } from './sentinel-context';

describe('sentinelScopeLabel', () => {
  it('OFF → the primary hive slug (byte-identical to today)', () => {
    expect(sentinelScopeLabel('papercusp-workspace', 'papercusp', false)).toBe('papercusp');
  });

  it('ON → a workspace-scoped label spanning all hives', () => {
    expect(sentinelScopeLabel('papercusp-workspace', 'papercusp', true)).toBe(
      'workspace papercusp-workspace (all hives)',
    );
  });

  it('OFF falls back to the workspace id when there is no primary hive', () => {
    // converse-prompt passes `harnessSlugs[0] ?? wsId`, so an empty pool yields wsId.
    expect(sentinelScopeLabel('ws-x', 'ws-x', false)).toBe('ws-x');
  });

  it('is pure — the flag value is passed in, not read (deterministic)', () => {
    const a = sentinelScopeLabel('w', 'h', true);
    const b = sentinelScopeLabel('w', 'h', true);
    expect(a).toBe(b);
  });
});

describe('renderSentinelContext heading scoping', () => {
  it('renders the workspace scope label in the heading when ON', () => {
    const label = sentinelScopeLabel('papercusp-workspace', 'papercusp', true);
    const block = renderSentinelContext({ hiveSlug: label });
    expect(block).toContain('## Live system status — workspace papercusp-workspace (all hives)');
  });

  it('renders the per-hive label when OFF (unchanged behaviour)', () => {
    const label = sentinelScopeLabel('papercusp-workspace', 'papercusp', false);
    const block = renderSentinelContext({ hiveSlug: label });
    expect(block).toContain('## Live system status — papercusp');
    expect(block).not.toContain('(all hives)');
  });

  it('an all-quiet system still renders the heading + an explicit "no anomalies" (silence is trustworthy)', () => {
    const block = renderSentinelContext({ hiveSlug: 'papercusp' });
    expect(block).toContain('## Live system status — papercusp');
    expect(block).toContain('_no anomalies — system healthy._');
  });

  it('renders open deep delegations as a dedicated follow-up-status section', () => {
    const block = renderSentinelContext({
      hiveSlug: 'papercusp',
      delegations: [
        {
          id: 'WI-301',
          harness: 'papercusp',
          title: 'Deep dive: compare the migration strategies',
          state: 'todo',
          claimed: true,
          lastActivityAt: '2026-07-01T22:00:00.000Z',
        },
      ],
    });
    expect(block).toContain('### Open deep delegations');
    expect(block).toContain('WI-301 [papercusp] todo, claimed');
    expect(block).toContain('compare the migration strategies');
  });
});

describe('gatherSentinelContext', () => {
  it('carries open delegations through the gathered input', async () => {
    const ctx = await gatherSentinelContext({
      signals: async () => [],
      anomalies: async () => [],
      patterns: async () => ({ patterns: [], headline: 'all quiet' }),
      bees: async () => [],
      delegations: async () => [
        { id: 'WI-301', title: 'Deep dive: root-cause the flake', state: 'todo', claimed: true, lastActivityAt: '2026-07-01T22:00:00.000Z' },
      ],
    });
    expect(ctx.headline).toBe('all quiet');
    expect(ctx.delegations).toEqual([
      { id: 'WI-301', title: 'Deep dive: root-cause the flake', state: 'todo', claimed: true, lastActivityAt: '2026-07-01T22:00:00.000Z' },
    ]);
  });
});
