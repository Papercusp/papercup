/**
 * aggregateHivePrs — the hive-scoped PR rollup fan-out (EI-331 /
 * hive-pr-rollup-and-subharness-membership P-005). Pins: member tagging,
 * per-member error isolation (one broken member ≠ hive-wide outage), bounded
 * concurrency, and the stable member/number ordering.
 */
import { describe, test, expect } from 'vitest';
import { aggregateHivePrs, type HarnessPrListing } from './prs';
import type { PrRowData } from '../../../pr-host/pr-row-data';

function pr(number: number, overrides: Partial<PrRowData> = {}): PrRowData {
  return {
    remote: 'github.com/acme/repo',
    number,
    title: `PR #${number}`,
    author_login: 'bee',
    author_github_id: 1,
    html_url: `https://github.com/acme/repo/pull/${number}`,
    state: 'open',
    review_decision: 'none',
    check_conclusion: null,
    trusted: false,
    reviewerRoleEnabled: false,
    ...overrides,
  };
}

describe('aggregateHivePrs', () => {
  test('tags every row with its member_slug and merges across members', async () => {
    const lister = async (slug: string): Promise<HarnessPrListing> => ({
      ok: true,
      prs: slug === 'acme' ? [pr(1)] : [pr(7), pr(3)],
    });
    const { prs, memberErrors } = await aggregateHivePrs(['acme', 'acme-web'], lister);
    expect(prs.map((p) => [p.member_slug, p.number])).toEqual([
      ['acme', 1],
      ['acme-web', 7],
      ['acme-web', 3],
    ]);
    expect(memberErrors).toEqual({});
  });

  test('one broken member is a PER-MEMBER error, not a hive-wide outage', async () => {
    const lister = async (slug: string): Promise<HarnessPrListing> => {
      if (slug === 'dead') return { ok: false, reason: 'poll_failed', pollingFailedAt: 'T0' };
      if (slug === 'local-only') return { ok: false, reason: 'no_remote' };
      return { ok: true, prs: [pr(2)] };
    };
    const { prs, memberErrors } = await aggregateHivePrs(['acme', 'dead', 'local-only'], lister);
    expect(prs).toHaveLength(1);
    expect(prs[0].member_slug).toBe('acme');
    expect(memberErrors).toEqual({
      dead: { pollingFailedAt: 'T0' },
      'local-only': { noRemote: true },
    });
  });

  test('unknown_project members are skipped silently (registry/grouping race)', async () => {
    const lister = async (slug: string): Promise<HarnessPrListing> =>
      slug === 'ghost' ? { ok: false, reason: 'unknown_project' } : { ok: true, prs: [pr(5)] };
    const { prs, memberErrors } = await aggregateHivePrs(['acme', 'ghost'], lister);
    expect(prs).toHaveLength(1);
    expect(memberErrors).toEqual({});
  });

  test('bounded concurrency: never more than `concurrency` listers in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const lister = async (): Promise<HarnessPrListing> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, prs: [] };
    };
    const members = Array.from({ length: 12 }, (_, i) => `m${i}`);
    await aggregateHivePrs(members, lister, 4);
    expect(peak).toBeLessThanOrEqual(4);
  });

  test('rows sort by member then descending PR number regardless of arrival order', async () => {
    const lister = async (slug: string): Promise<HarnessPrListing> => {
      // Stagger so completion order differs from member order.
      await new Promise((r) => setTimeout(r, slug === 'a' ? 10 : 1));
      return { ok: true, prs: slug === 'a' ? [pr(1), pr(9)] : [pr(4)] };
    };
    const { prs } = await aggregateHivePrs(['a', 'b'], lister, 2);
    expect(prs.map((p) => [p.member_slug, p.number])).toEqual([
      ['a', 9],
      ['a', 1],
      ['b', 4],
    ]);
  });

  test('empty member list → empty result, no workers', async () => {
    const { prs, memberErrors } = await aggregateHivePrs([], async () => {
      throw new Error('must not be called');
    });
    expect(prs).toEqual([]);
    expect(memberErrors).toEqual({});
  });
});
