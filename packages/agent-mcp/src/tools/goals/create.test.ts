/**
 * goals:create — the write half of `harness_shared.goals`
 * (goal-mode-2026-08-07 P-009).
 *
 * The behaviours worth pinning are the ones the SCHEMA punishes silently:
 * `workspace_id` is NOT NULL with a `CHECK (workspace_id <> '')`, so the
 * blank-stamp fallback that other write tools use here would produce a
 * constraint error instead of a legible refusal — and would have re-created the
 * blank-workspace rows EI-280 had to repair. The rest is the goal-vs-pot
 * distinction: the kill criterion and spend ceiling must survive the write,
 * because they are the whole reason a goal needs a record of its own.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import tool, { goalId, GOAL_STATUSES } from './create';

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let gucWorkspace: string | null = null;
/** Whether the caller has a GOAL-mode row for the subject UPDATE to hit. */
let callerInGoalMode = false;
/** Forces the subject stamp to throw, proving the goal still gets created. */
let modeUpdateThrows = false;

/** A postgres-js-shaped tagged-template `tx` that records what it was asked. */
function makeTx() {
  return (strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = strings.join('?');
    calls.push({ sql, params });
    if (/current_setting/.test(sql)) return Promise.resolve([{ ws: gucWorkspace }]);
    if (/UPDATE harness_shared\.agent_modes/.test(sql)) {
      if (modeUpdateThrows) return Promise.reject(new Error('agent_modes is on fire'));
      return Promise.resolve(callerInGoalMode ? [{ owner_id: 'su-test' }] : []);
    }
    return Promise.resolve([]);
  };
}

const CTX = (over: Record<string, unknown> = {}) => ({
  tx: makeTx() as never,
  workspaceId: 'papercusp-workspace',
  harnessSlug: 'papercusp',
  uiClientId: 'su-test',
  log: () => {},
  ...over,
});

const ARGS = (over: Record<string, unknown> = {}) =>
  tool.args.parse({ title: 'Ship a paid app', ...over });

/**
 * `handler` is typed as the `ToolResult | ToolResponse<unknown>` union, so a
 * bare `res.data` does not narrow. The rest of this package's test corpus reads
 * it unnarrowed and carries the resulting TS2339s in its baseline; narrowing
 * here keeps these files from adding to that pile.
 */
type Res = { data: unknown; degraded?: boolean; degradedReasons?: string[] };
const call = async (args: unknown, ctx: unknown): Promise<Res> =>
  (await tool.handler(args as never, ctx as never)) as Res;

beforeEach(() => {
  calls = [];
  gucWorkspace = null;
  callerInGoalMode = false;
  modeUpdateThrows = false;
});

describe('goals:create — workspace resolution', () => {
  it('prefers the app.workspace_id GUC over ctx.workspaceId', async () => {
    gucWorkspace = 'from-guc';
    const res = await call(ARGS(), CTX());
    expect((res.data as { workspace_id: string }).workspace_id).toBe('from-guc');
  });

  it('falls back to ctx.workspaceId when the GUC is unset', async () => {
    const res = await call(ARGS(), CTX());
    expect((res.data as { workspace_id: string }).workspace_id).toBe('papercusp-workspace');
  });

  it('REFUSES rather than writing a blank workspace_id the CHECK would reject', async () => {
    const res = await call(ARGS(), CTX({ workspaceId: undefined }));
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.join(' ')).toMatch(/workspace/i);
    // The refusal must happen BEFORE the insert, not be cleaned up after one.
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });

  it('treats the wildcard workspace "*" as no concrete workspace', async () => {
    const res = await call(ARGS(), CTX({ workspaceId: '*' }));
    expect(res.data).toBeNull();
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });

  it('refuses when no harness is in scope — a goal is filed against an install', async () => {
    const res = await call(ARGS(), CTX({ harnessSlug: undefined }));
    expect(res.data).toBeNull();
    expect(res.degradedReasons?.join(' ')).toMatch(/harness/i);
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });
});

describe('goals:create — what the row must carry', () => {
  it('persists the kill criterion, which no pot could carry for a multi-project goal', async () => {
    const res = await call(ARGS({ killCriterion: 'no paying user after 2 weeks' }), CTX());
    expect((res.data as { kill_criterion: string }).kill_criterion).toBe('no paying user after 2 weeks');
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(JSON.stringify(insert.params)).toContain('no paying user after 2 weeks');
  });

  it('persists the declared spend ceiling', async () => {
    const res = await call(ARGS({ budgetCents: 50_000 }), CTX());
    expect((res.data as { budget_cents: number }).budget_cents).toBe(50_000);
  });

  it('writes null metadata rather than an empty object when there is nothing to record', async () => {
    await call(ARGS(), CTX());
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(insert.params).toContain(null);
    expect(JSON.stringify(insert.params)).not.toContain('{}');
  });

  it('supports a sub-goal via parentId (the table\'s self-referencing lineage edge)', async () => {
    const res = await call(ARGS({ parentId: 'parent-abc123' }), CTX());
    expect((res.data as { parent_id: string }).parent_id).toBe('parent-abc123');
  });
});

describe('goals:create — the kill criterion is a COLUMN, not a metadata key', () => {
  /**
   * It lived in `metadata` only because the column did not exist. The whole GUI
   * reads it — the detail view's "THIS GOAL ENDS WHEN" headline is the single
   * most load-bearing string in goal mode — and a jsonb key cannot be indexed
   * or joined the way the read path needs. If this regresses, the criterion
   * still *round-trips through the tool* (so a handler test alone would pass)
   * while rendering blank everywhere the owner actually looks.
   */
  it('sends the criterion to the kill_criterion column and NOT into metadata', async () => {
    await call(ARGS({ killCriterion: 'no paying user after 2 weeks' }), CTX());
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(insert.sql).toMatch(/kill_criterion/);
    // The metadata parameter must be null — the criterion is not hiding in it.
    const jsonParams = insert.params.filter((p): p is string => typeof p === 'string' && p.startsWith('{'));
    expect(jsonParams.join(' ')).not.toContain('no paying user');
  });

  it('persists tripwires as jsonb so the criterion renders as bars, not prose', async () => {
    const tripwires = [
      { metric: 'spend_usd', label: '$310 of $500', threshold: 500, current: 310, unit: 'usd' },
    ];
    const res = await call(ARGS({ killCriterion: 'stop at $500', tripwires }), CTX());
    expect((res.data as { tripwires: unknown }).tripwires).toEqual(tripwires);
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(insert.sql).toMatch(/tripwires/);
    expect(JSON.stringify(insert.params)).toContain('spend_usd');
  });

  it('leaves tripwires null when none are given — a prose-only criterion is valid', async () => {
    // ⚠ The criterion here must clear `killCriterionProblem` (≥12 chars, no
    // placeholder opener). This test is about TRIPWIRES — the criterion is
    // incidental fixture data — but since EI-20049757392342975 `goals:create`
    // refuses a stub BEFORE reaching the INSERT, so a short one would return
    // `degraded`, leave `calls` without an INSERT, and blow up on the `!` below
    // as a TypeError. That reads like a broken mock rather than a rejected
    // input — the exact costume this failure wears (it red-pinned the gate via
    // goals/update.test.ts on 2026-08-10, EI-20048757608108893).
    // It was `'gut feel'` (8 chars), which asserted the pre-fix bug as correct.
    await call(ARGS({ killCriterion: 'no paying user by day 30' }), CTX());
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(JSON.stringify(insert.params)).not.toContain('[]');
  });

  // ── EI-20049757392342975: the refusal itself ────────────────────────────
  describe('kill criterion — the shared rule, applied at THIS door too', () => {
    it('refuses a stub criterion instead of writing it, the way goals:propose and goals:update do', async () => {
      const res = await call(ARGS({ killCriterion: 'gut feel' }), CTX());
      expect(res.degraded).toBe(true);
      expect(res.degradedReasons?.[0]).toMatch(/states no abandonment condition/);
      // The REAL assertion: nothing was written. A refusal that still inserts
      // is the bug wearing a better error message.
      expect(calls.find((c) => /INSERT INTO/.test(c.sql))).toBeUndefined();
    });

    it('refuses a placeholder opener even when it is long enough', async () => {
      const res = await call(ARGS({ killCriterion: 'TBD once we see some real numbers' }), CTX());
      expect(res.degraded).toBe(true);
      // Assert the REASON, not just the refusal: this string clears the length
      // bar, so a bare `degraded` here could be some unrelated rejection and the
      // test would pass without exercising PLACEHOLDER_OPENER at all.
      expect(res.degradedReasons?.[0]).toMatch(/states no abandonment condition/);
      expect(calls.find((c) => /INSERT INTO/.test(c.sql))).toBeUndefined();
    });

    // CONTROL for WI-37604 (owner-directed 2026-08-09): the overrule is about
    // PRESENCE, this rule is about quality GIVEN presence. Without this case a
    // guard that simply required a criterion would pass every test above while
    // silently re-imposing the requirement the owner removed.
    it('still allows NO criterion at all — WI-37604 is about presence, not quality', async () => {
      const res = await call(ARGS({ killCriterion: undefined }), CTX());
      expect(res.degraded).not.toBe(true);
      expect(calls.find((c) => /INSERT INTO/.test(c.sql))).toBeDefined();
    });

    it('still allows a blank criterion, for the same reason', async () => {
      const res = await call(ARGS({ killCriterion: '   ' }), CTX());
      expect(res.degraded).not.toBe(true);
      expect(calls.find((c) => /INSERT INTO/.test(c.sql))).toBeDefined();
    });
  });
});

describe('goals:create — stamping the caller\'s GOAL mode (the provenance mechanism)', () => {
  /**
   * P-016. Everything created after this reads `agent_modes.subject` from
   * session context to fill `goal_id`, which is why "what belongs to this
   * goal?" is answerable at all. The alternative — asking the agent to
   * remember to pass the id — does not survive a compaction.
   */
  it('points the caller\'s GOAL mode at the new goal', async () => {
    callerInGoalMode = true;
    const res = await call(ARGS(), CTX());
    const id = (res.data as { id: string }).id;
    const upd = calls.find((c) => /UPDATE harness_shared\.agent_modes/.test(c.sql))!;
    expect(upd).toBeDefined();
    expect(upd.params).toContain(id);
    expect(upd.params).toContain('su-test');
    expect((res.data as { mode_subject_stamped: boolean }).mode_subject_stamped).toBe(true);
  });

  it('scopes the stamp to the caller AND the workspace, never a blanket update', async () => {
    callerInGoalMode = true;
    await call(ARGS(), CTX());
    const upd = calls.find((c) => /UPDATE harness_shared\.agent_modes/.test(c.sql))!;
    expect(upd.sql).toMatch(/workspace_id\s*=/);
    expect(upd.sql).toMatch(/owner_id\s*=/);
    expect(upd.sql).toMatch(/mode\s*=\s*'goal'/);
  });

  it('reports stamped:false — not an error — when the caller is not in GOAL mode', async () => {
    callerInGoalMode = false;
    const res = await call(ARGS(), CTX());
    expect(res.data).not.toBeNull();
    expect((res.data as { mode_subject_stamped: boolean }).mode_subject_stamped).toBe(false);
    expect((res.data as { mode_subject_advisory?: unknown }).mode_subject_advisory).toBeUndefined();
  });

  it.each([
    ['kill criterion', { killCriterion: 'no paying user after 2 weeks' }],
    ['zero budget', { budgetCents: 0 }],
    [
      'tripwire',
      {
        tripwires: [
          { metric: 'spend_usd', label: '$310 of $500', threshold: 500, current: 310, unit: 'usd' },
        ],
      },
    ],
  ])('returns a loud mode advisory when %s is supplied outside GOAL mode', async (_label, controls) => {
    const res = await call(ARGS(controls), CTX());
    const data = res.data as {
      id: string;
      mode_subject_stamped: boolean;
      mode_subject_advisory?: {
        code: string;
        severity: string;
        message: string;
        next: Array<{ tool: string; args?: Record<string, unknown> }>;
      };
    };

    expect(data.mode_subject_stamped).toBe(false);
    expect(data.mode_subject_advisory).toMatchObject({
      code: 'goal_mode_not_active',
      severity: 'warning',
    });
    expect(data.mode_subject_advisory?.message).toMatch(/not in GOAL mode/i);
    expect(data.mode_subject_advisory?.next.map((step) => step.tool)).toEqual(['goals:start', 'mode:set']);
    expect(data.mode_subject_advisory?.next[1]?.args).toMatchObject({
      mode: 'goal',
      subject: data.id,
    });
  });

  it('does not warn when the caller is already in GOAL mode', async () => {
    callerInGoalMode = true;
    const res = await call(ARGS({ budgetCents: 0 }), CTX());
    expect((res.data as { mode_subject_stamped: boolean }).mode_subject_stamped).toBe(true);
    expect((res.data as { mode_subject_advisory?: unknown }).mode_subject_advisory).toBeUndefined();
  });

  it('does not attempt the stamp at all when the transport carried no session id', async () => {
    const res = await call(ARGS(), CTX({ uiClientId: null }));
    expect(res.data).not.toBeNull();
    expect(calls.some((c) => /agent_modes/.test(c.sql))).toBe(false);
  });

  it('still creates the goal when the stamp throws — a decoration must never fail the write', async () => {
    modeUpdateThrows = true;
    const res = await call(ARGS({ killCriterion: 'no paying user after 2 weeks' }), CTX());
    expect(res.data).not.toBeNull();
    expect((res.data as { mode_subject_stamped: boolean }).mode_subject_stamped).toBe(false);
    expect((res.data as { mode_subject_advisory?: { code: string } }).mode_subject_advisory?.code).toBe(
      'goal_mode_not_active',
    );
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(true);
  });
});

describe('goals:create — arg contract', () => {
  it('defaults status to active', () => {
    expect(tool.args.parse({ title: 'x' }).status).toBe('active');
  });

  it('accepts every declared status and rejects an invented one', () => {
    for (const s of GOAL_STATUSES) {
      expect(tool.args.safeParse({ title: 'x', status: s }).success).toBe(true);
    }
    expect(tool.args.safeParse({ title: 'x', status: 'abandoned' }).success).toBe(false);
  });

  it('requires a title and rejects a negative or fractional budget', () => {
    expect(tool.args.safeParse({}).success).toBe(false);
    expect(tool.args.safeParse({ title: '' }).success).toBe(false);
    expect(tool.args.safeParse({ title: 'x', budgetCents: -1 }).success).toBe(false);
    expect(tool.args.safeParse({ title: 'x', budgetCents: 1.5 }).success).toBe(false);
  });
});

describe('goalId', () => {
  it('derives a readable slug from the title', () => {
    expect(goalId('Ship a paid app')).toMatch(/^ship-a-paid-app-[0-9a-f]{6}$/);
  });

  it('is collision-resistant for identical titles', () => {
    expect(goalId('same')).not.toBe(goalId('same'));
  });

  it('still produces a valid id when the title has no usable characters', () => {
    expect(goalId('!!! ???')).toMatch(/^goal-[0-9a-f]{6}$/);
  });

  it('bounds the stem so a long title cannot produce an unwieldy key', () => {
    const id = goalId('x'.repeat(300));
    expect(id.length).toBeLessThanOrEqual(48 + 1 + 6);
  });
});
