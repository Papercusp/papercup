/**
 * agent-goal-lens.test.ts — EI-20073149682963544.
 *
 * THE BUG. `readHeldPlanItems` filtered plan-item claims by `expires_ts > now()`
 * for every caller. `plan_item_claims.ttl_sec` defaults to 1200, so an agent
 * working ONE plan item for more than 20 minutes silently vanished from its own
 * goal — while the sibling `readHeldWorkItems` leg, in the same function, has no
 * expiry filter and kept answering. The two legs of "what am I doing" disagreed by
 * construction, and the disagreement grew with how long you had been working.
 *
 * WHY IT SURVIVED. The filter is CORRECT for the peer lens — someone else's lapsed
 * claim genuinely may be history — and one function served both audiences, so the
 * peer policy was quietly applied to self. That is the shape these tests pin: not
 * "the filter is gone" (it must not be, for peers) but "each audience gets its own
 * policy, and the self one discloses the lapse instead of hiding the row".
 *
 * ⚠ THE FAKE `sql` HONOURS THE PREDICATE IT IS HANDED rather than returning a
 * canned row set. A mock that always returns the same rows would pass whether or
 * not the `includeLapsed` parameter is actually threaded into the WHERE clause —
 * it would assert the query TEXT and prove nothing about the wiring. Here the fake
 * applies the boolean the way Postgres would, so a regression that drops the
 * parameter changes the RESULT and fails.
 *
 * Recipe from messages-outbox-pushdown.test.ts: only ./log is mocked, no DB.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/agent-goal-lens.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, fastPathState } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  fastPathState: { on: true },
}));

vi.mock('./log', () => ({
  coordSql: () => sqlMock,
  coordWorkspaceId: () => 'default',
  coordHasPgFastPath: () => fastPathState.on,
}));

// The override leg reads the facts store. Stubbed to "no override" so these tests
// exercise the plan-item leg rather than the precedence rule above it.
vi.mock('../../agent-facts/store', () => ({ foldFacts: async () => [] }));

import {
  assessAgentGoal,
  readGoalCandidates,
  resolveOwnerGoal,
  resolveOwnerGoalWithAssessment,
} from './agent-goal-sources';

const OWNER = 'su-lens-test';

interface ClaimRow {
  plan_slug: string;
  item_id: string;
  acquired_ts: string | null;
  intent: string | null;
  /** What `expires_ts > clock_timestamp()` would evaluate to for this row. */
  lease_valid: boolean;
}

interface RawLinkRow {
  src_kind: 'feature' | 'issue';
  src_ref: string;
  dst_ref: string;
}

/** A claim whose TTL has lapsed but which was never RELEASED — the live case. */
const LAPSED: ClaimRow = {
  plan_slug: 'retire-mug-kettle-su-only-2026-08-09',
  item_id: 'P-034',
  acquired_ts: '2026-08-10T00:00:00.000Z',
  intent: 'ship the scout seam',
  lease_valid: false,
};

const LIVE: ClaimRow = {
  plan_slug: 'retire-mug-kettle-su-only-2026-08-09',
  item_id: 'P-011',
  acquired_ts: '2026-08-09T00:00:00.000Z',
  intent: 'live lane',
  lease_valid: true,
};

/**
 * Route the four legs by query text, and — for the claims leg — APPLY the
 * `includeLapsed` boolean exactly as the SQL would.
 *
 * The captured `claimQueries` let a test read what was actually sent, but the
 * ASSERTIONS that matter are on the returned rows: text assertions cannot tell a
 * threaded parameter from a hard-coded `true`.
 */
function primeSql(
  claims: ClaimRow[],
  opts: {
    workItems?: { id: string; taken_at: string | null }[];
    links?: RawLinkRow[];
  } = {},
) {
  const claimQueries: { text: string; values: unknown[] }[] = [];
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);

    if (text.includes('plan_item_claims')) {
      claimQueries.push({ text, values });
      // Position 3 (0-based 2) is the includeLapsed flag: ws, owner, includeLapsed, cap.
      const includeLapsed = values[2];
      if (typeof includeLapsed !== 'boolean') {
        throw new Error(`includeLapsed was not threaded as a boolean parameter; got ${String(includeLapsed)}`);
      }
      const visible = includeLapsed ? claims : claims.filter((c) => c.lease_valid);
      // Mirror the ORDER BY: valid leases first.
      return Promise.resolve([...visible].sort((a, b) => Number(b.lease_valid) - Number(a.lease_valid)));
    }
    if (text.includes('work_items')) return Promise.resolve(opts.workItems ?? []);
    if (text.includes('fleet_membership_events')) return Promise.resolve([]);
    if (text.includes('coord_links')) {
      // Model the production join: feature edges carry a harness-qualified ref,
      // but the goal candidate carries the bare feature id. The conditional on
      // the feature join makes the regression fail against the old bare-id query
      // instead of handing it an already-normalized canned row.
      if (!text.includes('harness_features_consolidated')) return Promise.resolve([]);
      const heldIds = new Set((opts.workItems ?? []).map((w) => w.id));
      const normalized = (opts.links ?? []).flatMap((link) => {
        if (link.src_kind === 'issue') {
          return heldIds.has(link.src_ref) ? [{ work_item_id: link.src_ref, dst_ref: link.dst_ref }] : [];
        }
        const separator = link.src_ref.indexOf('#');
        const featureId = separator < 0 ? '' : link.src_ref.slice(separator + 1);
        return heldIds.has(featureId) ? [{ work_item_id: featureId, dst_ref: link.dst_ref }] : [];
      });
      return Promise.resolve(normalized);
    }
    return Promise.resolve([]);
  });
  return claimQueries;
}

beforeEach(() => {
  sqlMock.mockReset();
  fastPathState.on = true;
});

describe('the self lens — an agent must not lose its own goal to a TTL', () => {
  it('THE REGRESSION: a lapsed-but-unreleased own claim is still the goal, marked leaseCold', async () => {
    primeSql([LAPSED]);
    const goal = await resolveOwnerGoal(OWNER, 'self');

    // Before the fix this was `null`: the row existed, was still owned by us, and
    // the SQL deleted it 20 minutes in.
    expect(goal?.ref).toBe('retire-mug-kettle-su-only-2026-08-09#P-034');
    expect(goal?.source).toBe('plan-item');
    // The lapse is DISCLOSED, not hidden — otherwise the fix would trade a silent
    // disappearance for a silent overstatement (a cold claim read as a live fence).
    expect(goal?.leaseCold).toBe(true);
  });

  it('carries leaseValid:false through the candidates so the disclosure has a source', async () => {
    primeSql([LAPSED]);
    const c = await readGoalCandidates(OWNER, 'self');
    expect(c.planItems).toHaveLength(1);
    expect(c.planItems?.[0]?.leaseValid).toBe(false);
  });

  it('a warm lease is NOT reported cold', async () => {
    primeSql([LIVE]);
    const goal = await resolveOwnerGoal(OWNER, 'self');
    expect(goal?.ref).toBe('retire-mug-kettle-su-only-2026-08-09#P-011');
    expect(goal?.leaseCold).toBe(false);
  });

  it('prefers the LIVE claim over a cold one, even though the cold one is newer', async () => {
    // LAPSED.acquired_ts is a full day NEWER than LIVE's, so a plain recency sort
    // answers with the cold claim. `ttl_sec` is per-claim, so "acquired later" does
    // not imply "expires later" — recency alone cannot express this.
    primeSql([LAPSED, LIVE]);
    const goal = await resolveOwnerGoal(OWNER, 'self');
    expect(goal?.ref).toBe('retire-mug-kettle-su-only-2026-08-09#P-011');
    expect(goal?.leaseCold).toBe(false);
    // The cold one is still DISCLOSED rather than dropped.
    expect(goal?.competing).toContain('retire-mug-kettle-su-only-2026-08-09#P-034');
  });
});

describe('the peer lens — unchanged, and that is the point', () => {
  it('still hides a lapsed claim: a stranger cannot know whether it is history', async () => {
    primeSql([LAPSED]);
    expect(await resolveOwnerGoal(OWNER, 'peer')).toBeNull();
  });

  it('leaves leaseValid UNMEASURED, so no peer goal can ever read as cold', async () => {
    primeSql([LIVE]);
    const c = await readGoalCandidates(OWNER, 'peer');
    expect(c.planItems?.[0]?.leaseValid).toBeUndefined();
    expect((await resolveOwnerGoal(OWNER, 'peer'))?.leaseCold).toBe(false);
  });

  it('BOTH LENSES AGREE when the lease is warm — the lens only governs lapsed rows', async () => {
    primeSql([LIVE]);
    const mine = await resolveOwnerGoal(OWNER, 'self');
    primeSql([LIVE]);
    const theirs = await resolveOwnerGoal(OWNER, 'peer');
    expect(mine?.ref).toBe(theirs?.ref);
  });
});

describe('the query itself', () => {
  it('threads includeLapsed as a parameter and orders live leases first', async () => {
    const seen = primeSql([LAPSED]);
    await resolveOwnerGoal(OWNER, 'self');
    expect(seen).toHaveLength(1);
    expect(seen[0].values[2]).toBe(true);
    // The ORDER BY is load-bearing under GOAL_LEG_CAP: without it, lapsed rows can
    // evict live ones inside the LIMIT and the fix becomes a new way to lose a goal.
    expect(seen[0].text).toMatch(/ORDER BY\s*\(expires_ts > clock_timestamp\(\)\) DESC/);
  });

  it('the peer lens sends includeLapsed=false', async () => {
    const seen = primeSql([LAPSED]);
    await resolveOwnerGoal(OWNER, 'peer');
    expect(seen[0].values[2]).toBe(false);
  });

  it('reads lease validity off clock_timestamp(), not the statement clock', async () => {
    // now() is the TRANSACTION start time. These reads sit inside a request that may
    // have begun earlier, so now() can report a lease live that expired mid-request.
    const seen = primeSql([LIVE]);
    await resolveOwnerGoal(OWNER, 'self');
    expect(seen[0].text).toContain('clock_timestamp()');
    expect(seen[0].text).not.toMatch(/expires_ts > now\(\)/);
  });
});

describe('implements-link ref normalization', () => {
  it('normalizes a harness-qualified feature edge to the held bare feature id', async () => {
    const featureId = 'WI-feature-goal';
    const planItemRef = `${LIVE.plan_slug}#${LIVE.item_id}`;
    primeSql([LIVE], {
      workItems: [{ id: featureId, taken_at: '2026-08-11T00:00:00.000Z' }],
      links: [{ src_kind: 'feature', src_ref: `papercusp#${featureId}`, dst_ref: planItemRef }],
    });

    const candidates = await readGoalCandidates(OWNER, 'self');

    expect(candidates.links).toEqual([{ workItemId: featureId, planItemRef }]);
  });

  it('keeps issue-family implements edges in their existing bare-ref form', async () => {
    const issueId = 'EI-issue-goal';
    const planItemRef = `${LIVE.plan_slug}#${LIVE.item_id}`;
    primeSql([LIVE], {
      workItems: [{ id: issueId, taken_at: '2026-08-11T00:00:00.000Z' }],
      links: [{ src_kind: 'issue', src_ref: issueId, dst_ref: planItemRef }],
    });

    const candidates = await readGoalCandidates(OWNER, 'self');

    expect(candidates.links).toEqual([{ workItemId: issueId, planItemRef }]);
  });
});

describe('fail-soft is preserved', () => {
  it('a dead claims leg costs the plan-item goal, not the whole read', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (text.includes('plan_item_claims')) return Promise.reject(new Error('table gone'));
      if (text.includes('work_items')) {
        return Promise.resolve([{ id: 'WI-37716', taken_at: '2026-08-10T12:00:00.000Z' }]);
      }
      return Promise.resolve([]);
    });
    const goal = await resolveOwnerGoal(OWNER, 'self');
    expect(goal?.ref).toBe('WI-37716');
    expect(goal?.leaseCold).toBe(false);

    const resolved = await resolveOwnerGoalWithAssessment(OWNER, 'self');
    expect(resolved.goal?.ref).toBe('WI-37716');
    expect(resolved.assessment).toBeNull();
    expect(resolved.diagnostics.map((d) => d.leg)).toContain('plan-items');
  });

  it('no PG fast path yields no goal rather than a throw', async () => {
    fastPathState.on = false;
    expect(await resolveOwnerGoal(OWNER, 'self')).toBeNull();
    expect(await resolveOwnerGoalWithAssessment(OWNER, 'self')).toMatchObject({
      goal: null,
      assessment: null,
      diagnostics: [{ leg: 'store', status: 'unavailable' }],
    });
  });
});

describe('agent.goal assessment truth table', () => {
  const goal = (agreement: 'sole' | 'corroborated' | 'divergent', competing: string[] = []) => ({
    ref: 'WI-1',
    source: 'work-item' as const,
    declaredAt: null,
    corroboratedBy: agreement === 'corroborated' ? 'plan#P-001' : null,
    competing,
    agreement,
    leaseCold: false,
  });

  it('covers every conclusion and withholds nothing-held when a contributing leg failed', () => {
    expect(assessAgentGoal(null, [])).toBe('nothing-held');
    expect(assessAgentGoal(goal('corroborated'), [])).toBe('corroborated');
    expect(assessAgentGoal(goal('sole'), [])).toBe('sole');
    expect(assessAgentGoal(goal('divergent'), [])).toBe('divergent');
    expect(assessAgentGoal(goal('sole', ['WI-2']), [])).toBe('divergent');
    expect(assessAgentGoal(null, [{ leg: 'work-items', status: 'unavailable', detail: 'pg down' }])).toBeNull();
  });
});
