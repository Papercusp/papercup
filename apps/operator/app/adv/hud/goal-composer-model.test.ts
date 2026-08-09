/**
 * The "+ Start a goal" composer's contract (goals-tab-improvement-2026-08-09 P-015).
 *
 * Two things are worth pinning here and neither needs a DOM:
 *
 *   1. KILL CRITERION AND CEILING ARE REQUIRED. GOAL mode mandates both at
 *      creation, and the conversational kickoff that used to ask for them was
 *      deleted with the rail — this form is now the only place the requirement
 *      is enforced client-side, so "the form accepts a goal without them" is a
 *      regression that would ship an unstoppable agent.
 *   2. THE RESPONSE IS A TWO-LAYER ENVELOPE. The projected-tool transport wraps
 *      the tool's `data` in MCP content, so the goal id is one parse deeper than
 *      it looks, and a REFUSAL arrives as isError + prose in that same slot.
 *      Reading the refusal correctly is what turns "unparseable response" into
 *      "the launch failed and everything was rolled back".
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ceilingToCents,
  postGoalStart,
  validateGoalDraft,
  type GoalComposerDraft,
} from './goal-composer-model';

const DRAFT: GoalComposerDraft = {
  title: 'Ship a paid app',
  killCriterion: 'no paying user by day 30',
  ceiling: '500',
};

/** A fetch stub returning one canned body. */
const fetchReturning = (body: string, init: { ok?: boolean; status?: number } = {}) =>
  vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => body,
  })) as unknown as typeof fetch;

/** The shape the projected-tool transport actually returns. */
const envelope = (data: unknown, isError = false) =>
  JSON.stringify({ content: [{ text: typeof data === 'string' ? data : JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });

describe('ceilingToCents', () => {
  it('accepts the forms an owner actually types', () => {
    expect(ceilingToCents('500')).toBe(50_000);
    expect(ceilingToCents('500.00')).toBe(50_000);
    expect(ceilingToCents('$500')).toBe(50_000);
    expect(ceilingToCents('1,250.50')).toBe(125_050);
    expect(ceilingToCents(' 0 ')).toBe(0);
  });

  it('rejects what is not an amount', () => {
    for (const bad of ['', 'abc', '-5', '5.005', '1e3', '.', '$']) {
      expect(ceilingToCents(bad)).toBeNull();
    }
  });
});

describe('validateGoalDraft', () => {
  it('passes a complete draft through as tool args', () => {
    const v = validateGoalDraft({ ...DRAFT, body: '  what winning looks like  ' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.args).toEqual({
      title: 'Ship a paid app',
      killCriterion: 'no paying user by day 30',
      budgetCents: 50_000,
      body: 'what winning looks like',
    });
  });

  it('omits an empty body rather than sending a blank string', () => {
    const v = validateGoalDraft({ ...DRAFT, body: '   ' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect('body' in v.args).toBe(false);
  });

  it('REFUSES a goal with no kill criterion', () => {
    const v = validateGoalDraft({ ...DRAFT, killCriterion: '   ' });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.killCriterion).toBeTruthy();
  });

  it('REFUSES a goal with no ceiling, and says which kind of wrong it is', () => {
    const missing = validateGoalDraft({ ...DRAFT, ceiling: '' });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.errors.ceiling).toContain('Required');

    // A typo is a DIFFERENT failure from an omission, and telling them apart is
    // the difference between "you forgot this" and "I could not read that".
    const unparseable = validateGoalDraft({ ...DRAFT, ceiling: 'about five hundred' });
    expect(unparseable.ok).toBe(false);
    if (unparseable.ok) return;
    expect(unparseable.errors.ceiling).toContain('dollars');
  });

  it('reports EVERY missing field at once, not just the first', () => {
    // Revealing them one at a time turns one correction into three round trips.
    const v = validateGoalDraft({ title: '', killCriterion: '', ceiling: '' });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(Object.keys(v.errors).sort()).toEqual(['ceiling', 'killCriterion', 'title']);
  });

  it('accepts a ZERO ceiling — it is a declared limit, not a missing one', () => {
    const v = validateGoalDraft({ ...DRAFT, ceiling: '0' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.args.budgetCents).toBe(0);
  });
});

describe('postGoalStart', () => {
  const opts = { workspaceId: 'ws-1', harnessSlug: 'papercusp' };

  it('unwraps the goal id and the agent id from the two-layer envelope', async () => {
    const fetchImpl = fetchReturning(
      envelope({ id: 'ship-paid-app-3f9a1c', agent_owner_id: 'su-abc' }),
    );
    const res = await postGoalStart(
      { title: 't', killCriterion: 'k', budgetCents: 1 },
      { ...opts, fetchImpl },
    );
    expect(res).toEqual({ ok: true, goalId: 'ship-paid-app-3f9a1c', agentOwnerId: 'su-abc' });
  });

  it('POSTs to goals/start with the workspace + harness scoped in', async () => {
    const fetchImpl = fetchReturning(envelope({ id: 'g-1' }));
    await postGoalStart({ title: 't', killCriterion: 'k', budgetCents: 1 }, { ...opts, fetchImpl });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(url).toContain('/api/agent-tools/goals/start');
    expect(url).toContain('ws=ws-1');
    expect(url).toContain('harness=papercusp');
    expect(JSON.parse(String(init.body))).toMatchObject({ harness: 'papercusp', budgetCents: 1 });
  });

  it('surfaces a REFUSAL\'s prose, which is what names the rollback', async () => {
    // isError + prose in the content slot. Read as "unparseable" this would
    // tell the owner nothing about whether a half-started goal is now sitting
    // in their board — the one thing they need to know.
    const fetchImpl = fetchReturning(
      envelope("The goal's agent failed to launch (no display). The goal row and its mode stamp were ROLLED BACK.", true),
    );
    const res = await postGoalStart(
      { title: 't', killCriterion: 'k', budgetCents: 1 },
      { ...opts, fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('ROLLED BACK');
  });

  it('does not report success when the tool returned no id', async () => {
    const fetchImpl = fetchReturning(envelope({ degradedReasons: ['no harness in scope'] }));
    const res = await postGoalStart(
      { title: 't', killCriterion: 'k', budgetCents: 1 },
      { ...opts, fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('no harness in scope');
  });

  it('reports an HTTP failure with its status', async () => {
    const fetchImpl = fetchReturning('nope', { ok: false, status: 403 });
    const res = await postGoalStart(
      { title: 't', killCriterion: 'k', budgetCents: 1 },
      { ...opts, fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('403');
  });

  it('reports a transport failure instead of throwing into the click handler', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('operator unreachable');
    }) as unknown as typeof fetch;
    const res = await postGoalStart(
      { title: 't', killCriterion: 'k', budgetCents: 1 },
      { ...opts, fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('operator unreachable');
  });
});
