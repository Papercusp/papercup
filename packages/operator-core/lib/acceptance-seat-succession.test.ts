/**
 * WI-2141007 — acceptance seat succession when the rubric author is dead.
 *
 * The rails here are the ONLY thing standing between "a reaped implementer no
 * longer bricks a plan" and "any live agent can accept any plan's grading", so
 * each refusal reason gets its own case, and the two safety directions are
 * asserted explicitly: a live author's seat is never takeable, and an unreadable
 * liveness verdict never widens authority.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAcceptanceSeatBasis,
  resolveAcceptanceSeatSuccession,
  acceptanceSeatRefusalHint,
} from './acceptance-seat-succession';

const WORKSPACE = 'papercusp-workspace';
const AUTHOR = 'su-dead-author';
const CALLER = 'su-live-successor';
const PLAN = 'portal-universal-bar-and-agent-roster-2026-08-31';

/**
 * A `postgres`-shaped tagged template that records the SQL it was handed and
 * answers the outer SELECT with `rows`. Nested fragments (the optional
 * harness predicate) come back as inert markers, matching how postgres.js
 * composes a fragment into an enclosing query.
 */
function fakeSql(rows: Array<{ feature_id: string | null }>) {
  const seen: string[] = [];
  const seenFragments: string[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    seenFragments.push(text);
    if (!text.includes('SELECT')) return { fragment: text, values };
    seen.push(text);
    return Promise.resolve(rows);
  }) as unknown as NonNullable<Parameters<typeof resolveAcceptanceSeatBasis>[2]>['sql'];
  return { sql, seen, seenFragments };
}

const endedAuthor = async () => 'ended';
const liveAuthor = async () => 'live';
const unknownAuthor = async () => null;

function succession(overrides: Partial<Parameters<typeof resolveAcceptanceSeatSuccession>[0]> = {}) {
  const { sql } = fakeSql([{ feature_id: 'WI-1687546' }]);
  return resolveAcceptanceSeatSuccession({
    authorId: AUTHOR,
    callerId: CALLER,
    subjectPlan: PLAN,
    workspaceId: WORKSPACE,
    resolveAuthorSessionState: endedAuthor,
    sql,
    now: () => new Date('2026-09-02T13:00:00.000Z'),
    ...overrides,
  });
}

describe('resolveAcceptanceSeatBasis', () => {
  it('reads the canonical work_items BASE TABLE, never the issue-family engineer_issues view', async () => {
    // The view omits feature-family WI-/F- rows, and a plan's acceptance-ceremony
    // item is normally feature-family — so keying succession off the view would
    // make it silently ineligible in exactly its main case. Pin the relation.
    const { sql, seen } = fakeSql([{ feature_id: 'WI-1687546' }]);
    await resolveAcceptanceSeatBasis(CALLER, PLAN, { sql, workspaceId: WORKSPACE });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('harness_shared.work_items');
    expect(seen[0]).not.toContain('engineer_issues');
  });

  it('scopes the read by workspace and keys accountability on taken_by', async () => {
    const { sql, seen } = fakeSql([{ feature_id: 'WI-1687546' }]);
    await resolveAcceptanceSeatBasis(CALLER, PLAN, { sql, workspaceId: WORKSPACE });
    expect(seen[0]).toContain('workspace_id');
    expect(seen[0]).toContain('taken_by');
  });

  it('recognizes the canonical acceptance-drain work-item marker when plan rows are terminal', async () => {
    const { sql, seenFragments } = fakeSql([{ feature_id: 'WI-acceptance-drain' }]);
    await expect(
      resolveAcceptanceSeatBasis(CALLER, PLAN, {
        sql,
        workspaceId: WORKSPACE,
        harness: 'papercusp',
      }),
    ).resolves.toEqual({
      workItemId: 'WI-acceptance-drain',
      planSlug: PLAN,
    });
    expect(seenFragments.some((text) => text.includes("payload ->> 'acceptanceDrainPlan'"))).toBe(true);
  });

  it('returns the held item and its plan when one matches', async () => {
    const { sql } = fakeSql([{ feature_id: 'WI-1687546' }]);
    await expect(resolveAcceptanceSeatBasis(CALLER, PLAN, { sql, workspaceId: WORKSPACE })).resolves.toEqual({
      workItemId: 'WI-1687546',
      planSlug: PLAN,
    });
  });

  it('returns null when the caller holds nothing for the plan', async () => {
    const { sql } = fakeSql([]);
    await expect(resolveAcceptanceSeatBasis(CALLER, PLAN, { sql, workspaceId: WORKSPACE })).resolves.toBeNull();
  });

  it('does not query at all without a subject plan', async () => {
    const { sql, seen } = fakeSql([{ feature_id: 'WI-1687546' }]);
    await expect(resolveAcceptanceSeatBasis(CALLER, '', { sql, workspaceId: WORKSPACE })).resolves.toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe('resolveAcceptanceSeatSuccession', () => {
  it('grants the seat when the author has ended and the caller holds the plan work-item', async () => {
    const result = await succession();
    expect(result.eligible).toBe(true);
    if (!result.eligible) throw new Error('unreachable');
    expect(result.succession).toEqual({
      succeededFrom: AUTHOR,
      authorSessionState: 'ended',
      basisWorkItemId: 'WI-1687546',
      basisPlanSlug: PLAN,
      succeededAt: '2026-09-02T13:00:00.000Z',
    });
  });

  it('REFUSES while the author is still reachable — a live seat is never takeable', async () => {
    const result = await succession({ resolveAuthorSessionState: liveAuthor });
    expect(result).toMatchObject({ eligible: false, reason: 'author_still_reachable' });
  });

  it.each(['parked', 'draining', 'recorded'])('refuses a still-reachable author in state %s', async (state) => {
    const result = await succession({ resolveAuthorSessionState: async () => state });
    expect(result).toMatchObject({ eligible: false, reason: 'author_still_reachable' });
  });

  it('REFUSES on an unreadable liveness verdict — silence must not widen authority', async () => {
    const result = await succession({ resolveAuthorSessionState: unknownAuthor });
    expect(result).toMatchObject({ eligible: false, reason: 'author_state_unknown' });
  });

  it('refuses when the liveness probe throws, rather than assuming the author is dead', async () => {
    const result = await succession({
      resolveAuthorSessionState: async () => {
        throw new Error('probe fault');
      },
    });
    expect(result).toMatchObject({ eligible: false, reason: 'author_state_unknown' });
  });

  it('refuses a caller who is not accountable for the plan', async () => {
    const { sql } = fakeSql([]);
    const result = await succession({ sql });
    expect(result).toMatchObject({ eligible: false, reason: 'caller_not_accountable_for_plan' });
  });

  it('refuses when the accountability query faults, rather than granting the seat', async () => {
    const sql = ((strings: TemplateStringsArray) => {
      if (!strings.join('?').includes('SELECT')) return { fragment: true };
      throw new Error('pg down');
    }) as never;
    const result = await succession({ sql });
    expect(result).toMatchObject({ eligible: false, reason: 'caller_not_accountable_for_plan' });
  });

  it('is not a succession when the caller already IS the author', async () => {
    const result = await succession({ callerId: AUTHOR });
    expect(result).toMatchObject({ eligible: false, reason: 'no_author_of_record' });
  });

  it('refuses a rubric with no author of record', async () => {
    const result = await succession({ authorId: null });
    expect(result).toMatchObject({ eligible: false, reason: 'no_author_of_record' });
  });

  it('refuses a rubric with no subject plan to be accountable for', async () => {
    const result = await succession({ subjectPlan: null });
    expect(result).toMatchObject({ eligible: false, reason: 'no_subject_plan' });
  });
});

describe('acceptanceSeatRefusalHint', () => {
  it('names the claim route, and warns a PEER off rebind while preserving it for a self-successor', () => {
    const hint = acceptanceSeatRefusalHint(
      { eligible: false, reason: 'caller_not_accountable_for_plan', authorSessionState: 'ended' },
      AUTHOR,
      PLAN,
    );
    expect(hint).toContain('work_items:claim');
    expect(hint).toContain(PLAN);
    // The repair the OLD refusal advertised, kept only for the case it fits.
    expect(hint).toContain('new sid');
    expect(hint).toContain('coord:rebind-identity');
    expect(hint).toContain('PEER');
  });

  it('tells a caller to ask the author when the author is still reachable', () => {
    const hint = acceptanceSeatRefusalHint(
      { eligible: false, reason: 'author_still_reachable', authorSessionState: 'parked' },
      AUTHOR,
      PLAN,
    );
    expect(hint).toContain('still reachable');
    expect(hint).not.toContain('work_items:claim');
  });

  it('says the verdict was unreadable rather than implying a dead author', () => {
    const hint = acceptanceSeatRefusalHint({ eligible: false, reason: 'author_state_unknown' }, AUTHOR, PLAN);
    expect(hint).toContain('could not be read');
    expect(hint).not.toContain('has ended');
  });
});
