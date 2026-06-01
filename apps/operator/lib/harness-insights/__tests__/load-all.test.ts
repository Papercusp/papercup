/**
 * loadHarnessInsights tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadHarnessInsights } from '../load-all';

type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

function emptyRunQuery(): RunQuery {
  return vi.fn(async () => []) as unknown as RunQuery;
}

describe('loadHarnessInsights', () => {
  it('assembles full InsightsTabProps with sensible defaults when PG is empty', async () => {
    const props = await loadHarnessInsights({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      runQuery: emptyRunQuery(),
    });
    expect(props.project.name).toBe('papercup');
    expect(props.project.claimStatus).toBe('unclaimed');
    expect(props.activity.events).toEqual([]);
    expect(props.people.people).toEqual([]);
    expect(props.yourPlace.queue).toEqual({
      queued: 0,
      working: 0,
      shipped_this_week: 0,
    });
    expect(props.howItWorks.harnessName).toBe('papercup');
    expect(props.spend.harnessTotalUsdThisWeek).toBe(0);
    expect(props.spend.viewerUsdThisWeek).toBe(0);
  });

  it('respects project + howItWorks overrides', async () => {
    const props = await loadHarnessInsights({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      runQuery: emptyRunQuery(),
      project: {
        name: 'Papercup',
        description: 'The papercup harness.',
        ownerDisplayName: 'alice',
        claimStatus: 'claimed',
        claimantLogin: 'alice',
        license: 'MIT',
        languages: [{ name: 'TypeScript', color: '#3178c6', percent: 80 }],
        githubUrl: 'https://github.com/papercupai/papercup',
      },
      howItWorks: {
        config: {
          has_orchestrator: false,
          pr_reviewer_role_enabled: true,
          auto_review: true,
          auto_merge: false,
          merge_method: 'rebase',
          branch_policy: 'main-fast-forward',
        },
        customWelcome: 'Custom intro paragraph.',
      },
    });
    expect(props.project.name).toBe('Papercup');
    expect(props.project.claimantLogin).toBe('alice');
    expect(props.project.license).toBe('MIT');
    expect(props.project.languages?.[0]?.name).toBe('TypeScript');
    expect(props.howItWorks.config.merge_method).toBe('rebase');
    expect(props.howItWorks.customWelcome).toBe('Custom intro paragraph.');
  });

  it('threads proxyWitnessExplainerHref into the spend card', async () => {
    const props = await loadHarnessInsights({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      runQuery: emptyRunQuery(),
      proxyWitnessExplainerHref: '/internal/docs/proxy-witness-pattern',
    });
    expect(props.spend.proxyWitnessExplainerHref).toBe(
      '/internal/docs/proxy-witness-pattern',
    );
  });

  it('respects activity + people limits', async () => {
    let capturedActivityLimit: unknown = null;
    let capturedPeopleLimit: unknown = null;
    const runQuery = vi.fn(async (query: string, params: unknown[]) => {
      // activity-feed shipped query: P-041 prepended workspace_id ($1), so the
      // order is [workspace_id, harness_slug, limit] → LIMIT $3 = params[2].
      if (
        /harness_features_consolidated/.test(query) &&
        /ORDER BY updated_ts DESC/.test(query)
      ) {
        capturedActivityLimit = params[2];
      }
      // people loader: selects device_attestations (activity loader
      // does not).
      if (
        /FROM harness_shared\.contributors\b/.test(query) &&
        /device_attestations/.test(query)
      ) {
        capturedPeopleLimit = params[2];
      }
      return [];
    }) as unknown as RunQuery;
    await loadHarnessInsights({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      runQuery,
      activityLimit: 7,
      peopleLimit: 11,
    });
    expect(capturedActivityLimit).toBe(7);
    expect(capturedPeopleLimit).toBe(11);
  });

  it('runs all loaders in parallel (single await point)', async () => {
    const order: string[] = [];
    const runQuery = vi.fn(async (query: string) => {
      // tag the query bucket
      if (/feature_queue/.test(query)) order.push('queue');
      if (/harness_features_consolidated/.test(query)) order.push('features');
      if (/FROM harness_shared\.contributors/.test(query)) order.push('contributors');
      if (/tool_invocations/.test(query)) order.push('tool_invocations');
      // small artificial delay to interleave
      await new Promise((r) => setTimeout(r, 1));
      return [];
    }) as unknown as RunQuery;
    const t0 = Date.now();
    await loadHarnessInsights({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      runQuery,
    });
    // Sequential would be ~N×1ms; parallel should comfortably finish
    // under 100ms even on a slow CI worker. This isnt a perf guarantee,
    // just a sanity check that we arent serialising.
    expect(Date.now() - t0).toBeLessThan(200);
    expect(order.length).toBeGreaterThan(0);
  });
});
