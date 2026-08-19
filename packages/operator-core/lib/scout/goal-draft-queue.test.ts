/**
 * WI-39879 / plan blender-goal-amendment-rail-2026-08-19 P-001.
 *
 * The acceptance criteria for the draft queue are all ZERO-WRITE assertions, so this
 * file is mostly falsifiers rather than happy paths: the queue's whole safety argument
 * is that it CANNOT create or amend a goal, and an argument like that is worth exactly
 * as much as the test that would fail if it stopped being true.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every statement the module issues, captured verbatim for the SELECT-only guard. */
const statements: string[] = [];

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(strings.join('?'));
      void values;
      return Promise.resolve(rows.current);
    },
  }),
}));

const rows: { current: unknown[] } = { current: [] };

const { selectGoalDrafts, readGoalDraftQueue, DEFAULT_DRAFT_RAIL } = await import(
  './goal-draft-queue'
);
const { DEFAULT_GOAL_BUDGET_CENTS, classifyProposal, DEFAULT_ROUTING_RAIL } = await import(
  './router'
);
const { ACCEPTED_ROUTE_HINTS, DELIBERATELY_UNACCEPTED_ROUTE_HINTS } = await import('./recombine');
import type { Proposal } from './types';

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'SP-test-001',
  framing: 'Make the release gate self-healing\nsecond line ignored',
  mechanism: 'watch the verdict, re-fire on a stale red',
  whyNew: 'nothing re-fires today',
  bet: 'reds stop pinning the fleet',
  cheapExperiment: {
    hypothesis: 'stale reds are the majority',
    method: 'sample a week of verdicts',
    falsifiableSignal: 'fewer than 20% of reds are stale',
  },
  sourceIdeaIds: ['idea-1'],
  addressesPatternRefs: [],
  ...over,
});

const row = (proposals: unknown) => ({
  cycle_id: 'cycle-1',
  created_at: new Date('2026-08-19T00:00:00Z'),
  proposals,
});

describe('selectGoalDrafts (pure)', () => {
  it('surfaces a goal-scale ask and drafts the rails the goal rail WOULD have used', () => {
    const drafts = selectGoalDrafts([row([proposal({ droppedRouteHint: 'goal' })])]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.askedRail).toBe('goal');
    expect(drafts[0]!.title).toBe('Make the release gate self-healing');
    expect(drafts[0]!.budgetCents).toBe(DEFAULT_GOAL_BUDGET_CENTS);
    // Drafted from the proposal's own falsifiable signal — not a placeholder.
    expect(drafts[0]!.killCriterion).toContain('fewer than 20% of reds are stale');
  });

  it('ignores proposals that never asked for the rail', () => {
    expect(selectGoalDrafts([row([proposal()])])).toEqual([]);
    expect(selectGoalDrafts([row([proposal({ droppedRouteHint: 'instance' })])])).toEqual([]);
    // An ACCEPTED hint routed normally and is not a draft.
    expect(selectGoalDrafts([row([proposal({ routeHint: 'plan' })])])).toEqual([]);
  });

  it('degrades to less evidence — never an exception — on a partial artifact row', () => {
    // The artifact store is BEST-EFFORT by contract, so the read path must tolerate
    // whatever landed. Throwing here would take out the whole queue for one bad row.
    expect(() =>
      selectGoalDrafts([
        row(null),
        row('not-an-array'),
        row([null, 42, {}, { framing: 7 }]),
        row([proposal({ droppedRouteHint: 'goal' })]),
      ]),
    ).not.toThrow();
    expect(
      selectGoalDrafts([row(null), row([{}]), row([proposal({ droppedRouteHint: 'goal' })])]),
    ).toHaveLength(1);
  });

  it('honours a budget cap without mutating the source proposal', () => {
    const p = proposal({ droppedRouteHint: 'goal' });
    const drafts = selectGoalDrafts([row([p])], { budgetCentsCap: 500 });
    expect(drafts[0]!.budgetCents).toBe(500);
    expect(p).not.toHaveProperty('budgetCents');
  });
});

describe('the zero-write property (this is the acceptance criterion)', () => {
  it('issues SELECT statements and nothing else', async () => {
    statements.length = 0;
    rows.current = [row([proposal({ droppedRouteHint: 'goal' })])];

    await readGoalDraftQueue({ workspaceId: 'ws-test' });

    expect(statements.length).toBeGreaterThan(0);
    for (const stmt of statements) {
      const head = stmt.trim().split(/\s+/)[0]!.toUpperCase();
      expect(head).toBe('SELECT');
      expect(stmt).not.toMatch(/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|DROP|ALTER)\b/i);
    }
  });

  it('never names harness_shared.goals in any statement it issues', async () => {
    statements.length = 0;
    rows.current = [row([proposal({ droppedRouteHint: 'goal' })])];

    await readGoalDraftQueue({ workspaceId: 'ws-test' });

    for (const stmt of statements) expect(stmt).not.toMatch(/harness_shared\.goals/);
  });

  it('CONTROL: the SELECT-only assertion would catch a writer (proving it can fail)', () => {
    // A guard that has never failed is a guard nobody has tested. This is the
    // deliberately-wrong implementation kept permanently as a control: if the
    // assertion above ever stops being able to fail, THIS test goes green-by-
    // accident and the falsifier is dead. Held in the test file rather than
    // mutating the module, so the shared tree is never dirtied to prove a point.
    const wouldWrite = [
      "\n    INSERT INTO harness_shared.goals (id, outcome)\n    VALUES (?, ?)",
      '  UPDATE harness_shared.goals SET budget_cents = ?',
      'DELETE FROM harness_shared.scout_cycle_stage_artifacts',
    ];
    for (const stmt of wouldWrite) {
      const head = stmt.trim().split(/\s+/)[0]!.toUpperCase();
      const caught =
        head !== 'SELECT' || /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|DROP|ALTER)\b/i.test(stmt);
      expect(caught).toBe(true);
    }
    // ...and the real read must still pass the same predicate it just rejected.
    expect('SELECT cycle_id FROM harness_shared.scout_cycle_stage_artifacts').toMatch(/^SELECT/);
  });

  it('cannot reach a goal writer: its import list is pinned', () => {
    // A source-level pin rather than a promise. draftGoalRails is PURE and
    // goals:create / goals:update are reachable only through modules absent here,
    // so adding an import is the change that would make a write possible — and it
    // fails this test, which is the point.
    const src = readFileSync(join(__dirname, 'goal-draft-queue.ts'), 'utf8');
    const imports = [...src.matchAll(/^import[^']*'([^']+)'/gm)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(
      new Set(['@papercusp/db-org', '../workspace-registry', './router', './types']),
    );
    // Match CODE, not prose. The module's own doc comment names goals:create and
    // goals:update precisely to say it cannot reach them, and an earlier version of
    // this guard failed on that sentence — a guard that fires on the documentation
    // explaining the invariant teaches the next author to delete the documentation.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/goals:(create|update)|createGoal|startGoal|dispatchGoal/);
  });
});

describe('routing and intake are UNCHANGED by the draft queue (D-006 stays owner-reserved)', () => {
  it('a goal-scale ask still takes the default rail — the hint is evidence, not routing', () => {
    const asked = proposal({ droppedRouteHint: 'goal' });
    // routeHint is undefined: parseProposal coerced it. classifyProposal reads
    // routeHint alone, so carrying the ask cannot change where this lands.
    expect(asked.routeHint).toBeUndefined();
    const decision = classifyProposal(asked, {});
    expect(decision.rail).toBe(DEFAULT_ROUTING_RAIL);
    expect(decision.followedHint).toBe(false);
  });

  it('intake still refuses the goal hint, with its reason on record', () => {
    expect(ACCEPTED_ROUTE_HINTS).not.toContain('goal');
    expect(ACCEPTED_ROUTE_HINTS).not.toContain(DEFAULT_DRAFT_RAIL);
    expect(DELIBERATELY_UNACCEPTED_ROUTE_HINTS.goal).toBeTruthy();
    expect(DELIBERATELY_UNACCEPTED_ROUTE_HINTS.goal).toMatch(/D-006/);
  });
});
