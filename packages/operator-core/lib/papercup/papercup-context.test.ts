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
import { sentinelScopeLabel, renderSentinelContext, gatherSentinelContext } from './papercup-context';

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
    const block = renderSentinelContext({ potSlug: label });
    expect(block).toContain('## Live system status — workspace papercusp-workspace (all hives)');
  });

  it('renders the per-hive label when OFF (unchanged behaviour)', () => {
    const label = sentinelScopeLabel('papercusp-workspace', 'papercusp', false);
    const block = renderSentinelContext({ potSlug: label });
    expect(block).toContain('## Live system status — papercusp');
    expect(block).not.toContain('(all hives)');
  });

  it('an all-quiet system still renders the heading + an explicit "no anomalies" (silence is trustworthy)', () => {
    const block = renderSentinelContext({ potSlug: 'papercusp' });
    expect(block).toContain('## Live system status — papercusp');
    expect(block).toContain('_no anomalies — system healthy._');
  });

  it('renders open deep delegations as a dedicated follow-up-status section', () => {
    const block = renderSentinelContext({
      potSlug: 'papercusp',
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

  // EI-13557: the Sentinel's own anomaly-line renderer must surface the escalate
  // conditionKey too — it is a SEPARATE renderer from the overwatch/Kettle one
  // (mirrors it), so the fix has to land in both or the Sentinel keeps inventing
  // ad hoc dedup keys the same way Overwatch/Kettle did.
  it('surfaces the escalate conditionKey inline so the reader passes it to coord:escalate verbatim', () => {
    const block = renderSentinelContext({
      potSlug: 'papercusp',
      anomalies: [
        {
          kind: 'escalation-aging',
          severity: 'warning',
          subject: 'escalations',
          detail: '283 escalation(s) aging past the attention threshold.',
          suggestedAction: {
            type: 'escalate',
            target: 'owner',
            conditionKey: 'overwatch:escalation-aging',
            message: '283 human-attention escalation(s) have aged past the attention threshold.',
          },
        },
      ],
    });
    expect(block).toContain('[conditionKey: overwatch:escalation-aging]');
    expect(block).toContain(
      "pass that exact string as coord:escalate's `conditionKey` argument — it coalesces repeated firings",
    );
  });

  it('does NOT annotate a nudge/observe anomaly with a conditionKey (escalate-only)', () => {
    const block = renderSentinelContext({
      potSlug: 'papercusp',
      anomalies: [
        {
          kind: 'bees-churning',
          severity: 'info',
          subject: 'bees',
          detail: '1 churning',
          suggestedAction: { type: 'nudge', target: 'mug', message: 're-place it' },
        },
      ],
    });
    // The intro's own explainer legitimately mentions `[conditionKey: …]` in the
    // abstract — scope this check to the rendered anomaly LINE, not the whole block.
    const line = block.split('\n').find((l) => l.includes('bees-churning'));
    expect(line).toBeTruthy();
    expect(line).not.toContain('[conditionKey');
  });

  it('marks raw signal identifiers as internal context and keeps the voice boundary explicit', () => {
    const sessionId = 'su-90cc5cbd-6f87-49b6-a475-71c31cc08341';
    const block = renderSentinelContext({
      potSlug: 'papercusp',
      signals: [
        {
          kind: 'blocker',
          title: `held by ended session ${sessionId}`,
          ref: `wi:${sessionId}`,
        },
      ],
    });

    expect(block).toContain('These lines are internal engineering context for tool use.');
    expect(block).toContain(sessionId);
    expect(block).toContain('paraphrase those identifiers in owner-facing replies');
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
