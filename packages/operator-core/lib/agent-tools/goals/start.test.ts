/**
 * goals:start — the ATOMICITY contract (goals-tab-improvement-2026-08-09 P-015).
 *
 * What is pinned here is not "does it insert a row" but the three properties a
 * three-call client-side version cannot have, each of which has a real failure
 * behind it:
 *
 *   1. The mode stamp is written BEFORE the spawn. It is what the agent reads on
 *      its first orient, so writing it after is a race against the agent's own
 *      boot — and losing that race is EI-20015592992797890 exactly: goals and
 *      goal-mode sessions coexisting with nothing joining them.
 *   2. The spawned command carries the SAME pre-pinned owner id the stamp names.
 *      A stamp on some other id is indistinguishable from no stamp at all.
 *   3. A failed spawn ROLLS BACK both writes. A goal with no agent is worse than
 *      no goal: it reads as an outcome being pursued while nothing pursues it.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/goals/start.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnConsoleResult } from '../../console-spawn';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../papercusp-root', () => ({ papercuspPathForWorkspace: () => '/tmp/papercusp-ws' }));
vi.mock('../../mcp-base-url', () => ({ resolveSpawnHostOperatorBaseUrl: () => 'http://127.0.0.1:3070' }));
vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async () => ({
    cwd: '/repo',
    env: { PAPERCUSP_SID: 'su-caller' },
    greetingCmd: '',
    mcpJsonContents: '',
  })),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({
    ownerId: 'su-caller',
    ownerLabel: 'su',
    source: 'psu',
    workspaceId: 'ws-test',
    userId: null,
  }),
}));

/** Every side effect, in the order it happened — property (1) is an ORDER claim. */
const order: string[] = [];

// Typed against the REAL SpawnConsoleResult so these mocks cannot drift from the
// spawn contract (the WI-4488 lesson: inferred-shape mocks went stale silently).
// Pinned to the `ok` VARIANT, not the whole union: spreading a union-typed value
// distributes over BOTH members, so `{ ...okSpawn(), … }` also produced a
// status:'error' branch carrying ok-only fields, which is assignable to neither.
type OkSpawn = Extract<SpawnConsoleResult, { status: 'ok' }>;
const okSpawn = (): OkSpawn => ({
  status: 'ok',
  pid: 4242,
  terminal: 'xterm',
  child: {} as never,
  display: ':1',
  desktopEnvResolvedVia: 'active-seat',
});
const spawnConsoleMock = vi.fn(async (_opts: unknown): Promise<SpawnConsoleResult> => {
  order.push('spawn');
  return okSpawn();
});
const spawnHeadlessMock = vi.fn(async (_opts: unknown): Promise<SpawnConsoleResult> => {
  order.push('spawn');
  return { ...okSpawn(), terminal: 'headless', pid: 777, display: null, desktopEnvResolvedVia: null };
});
vi.mock('../../console-spawn', () => ({
  spawnConsole: (o: unknown) => spawnConsoleMock(o),
  spawnHeadless: (o: unknown) => spawnHeadlessMock(o),
}));

type SetModeCall = { ownerId: string; modeId: string; enabled: boolean; subject?: string | null };
const setModeCalls: SetModeCall[] = [];
const setModeMock = vi.fn(async (opts: SetModeCall) => {
  setModeCalls.push(opts);
  order.push(opts.enabled ? 'mode-set' : 'mode-clear');
  return { ok: true };
});
vi.mock('../../modes/store', () => ({ setMode: (o: SetModeCall) => setModeMock(o) }));

const goalsStart = (await import('./start')).default;
const { buildGoalKickoffBrief } = await import('./start');
const { buildAgentLaunchCommand } = await import('../../agent-launch-core');

/** SQL the handler actually issued, as (text, values) pairs. */
const sql: Array<{ text: string; values: unknown[] }> = [];
const ctx = {
  workspaceId: 'ws-test',
  harnessSlug: 'papercusp',
  role: 'su',
  tx: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ? ');
    sql.push({ text, values });
    order.push(/INSERT/i.test(text) ? 'insert' : /DELETE/i.test(text) ? 'delete' : 'sql');
    return Promise.resolve([]);
  },
} as never;

const ARGS = {
  title: 'Ship a paid app',
  killCriterion: 'no paying user by day 30',
  budgetCents: 50_000,
};

const call = (extra: Record<string, unknown> = {}) =>
  (goalsStart as unknown as { handler: (a: unknown, c: unknown) => Promise<unknown> }).handler(
    { ...ARGS, ...extra },
    ctx,
  );
const dataOf = (res: unknown) => (res as { data: Record<string, unknown> }).data;
const textOf = (res: unknown) => (res as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '';
const isError = (res: unknown) => !!(res as { isError?: boolean }).isError;

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  sql.length = 0;
  setModeCalls.length = 0;
  spawnConsoleMock.mockImplementation(async () => {
    order.push('spawn');
    return okSpawn();
  });
  setModeMock.mockImplementation(async (opts: SetModeCall) => {
    setModeCalls.push(opts);
    order.push(opts.enabled ? 'mode-set' : 'mode-clear');
    return { ok: true };
  });
});

/**
 * The ordering predicate, extracted so it can be shown to DISCRIMINATE.
 *
 * An assertion of the form "the recorded order contains these steps" passes for
 * the broken implementation too, so the check itself is tested against a wrong
 * order below — otherwise a guard that can never fail reads exactly like a
 * guard that is being satisfied.
 */
export function stampPrecedesSpawn(recorded: string[]): boolean {
  const stamp = recorded.indexOf('mode-set');
  const spawn = recorded.indexOf('spawn');
  return stamp !== -1 && spawn !== -1 && stamp < spawn;
}

describe('the ordering predicate itself', () => {
  it('accepts stamp-then-spawn and REJECTS spawn-then-stamp', () => {
    expect(stampPrecedesSpawn(['insert', 'mode-set', 'spawn'])).toBe(true);
    // The naive three-call implementation this tool replaces: spawn, then stamp.
    expect(stampPrecedesSpawn(['insert', 'spawn', 'mode-set'])).toBe(false);
    // Never-stamped is the EI-20015592992797890 shape, and must not pass either.
    expect(stampPrecedesSpawn(['insert', 'spawn'])).toBe(false);
  });
});

describe('goals:start — the happy path', () => {
  it('writes the goal, stamps the mode, THEN spawns', async () => {
    const res = await call();
    expect(isError(res)).toBe(false);
    expect(stampPrecedesSpawn(order)).toBe(true);
    expect(order.filter((o) => o === 'insert')).toHaveLength(1);
    expect(order).not.toContain('delete');
  });

  it('stamps GOAL mode with the goal id as its SUBJECT', async () => {
    const res = await call();
    const goalId = dataOf(res).id as string;
    expect(setModeCalls).toHaveLength(1);
    expect(setModeCalls[0].modeId).toBe('goal');
    expect(setModeCalls[0].enabled).toBe(true);
    expect(setModeCalls[0].subject).toBe(goalId);
  });

  it('spawns the SAME owner id it stamped, pre-pinned via --owner-id', async () => {
    const res = await call();
    const ownerId = dataOf(res).agent_owner_id as string;
    expect(ownerId).toMatch(/^su-[0-9a-f-]{36}$/);
    // The stamp names the agent that is about to exist...
    expect(setModeCalls[0].ownerId).toBe(ownerId);
    // ...and the launch pins that exact identity, which is the only thing that
    // makes writing-before-spawning meaningful.
    const cmd = (spawnConsoleMock.mock.calls[0][0] as { envelope: { greetingCmd: string } }).envelope
      .greetingCmd;
    expect(cmd).toContain(`--owner-id=${ownerId}`);
  });

  it('delivers the goal as the agent\'s first turn via the env, not the command line', async () => {
    const res = await call();
    const env = (spawnConsoleMock.mock.calls[0][0] as { envelope: { env: Record<string, string> } })
      .envelope.env;
    const brief = env.PAPERCUSP_KICKOFF_PROMPT;
    expect(brief).toContain(dataOf(res).id as string);
    expect(brief).toContain('Ship a paid app');
    expect(brief).toContain('no paying user by day 30');
    // Free-form prose must never ride the greeting one-liner.
    const cmd = (spawnConsoleMock.mock.calls[0][0] as { envelope: { greetingCmd: string } }).envelope
      .greetingCmd;
    expect(cmd).not.toContain('Ship a paid app');
  });

  it('persists the kill criterion and ceiling as columns, not prose', async () => {
    const res = await call();
    const insert = sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text));
    expect(insert).toBeTruthy();
    expect(insert!.text).toContain('kill_criterion');
    expect(insert!.values).toContain('no paying user by day 30');
    expect(insert!.values).toContain(50_000);
    expect(dataOf(res).kill_criterion).toBe('no paying user by day 30');
    expect(dataOf(res).budget_cents).toBe(50_000);
  });

  it('routes a headless launch through spawnHeadless', async () => {
    await call({ headless: true });
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
});

describe('goals:start — rollback', () => {
  it('deletes the goal and clears the mode when the spawn fails', async () => {
    spawnConsoleMock.mockImplementation(async () => {
      order.push('spawn');
      return { status: 'error', error: 'no display' } as unknown as SpawnConsoleResult;
    });
    const res = await call();
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('ROLLED BACK');
    // Both compensations, and the delete is scoped to the row just written.
    expect(setModeCalls.some((c) => c.enabled === false)).toBe(true);
    const del = sql.find((s) => /DELETE FROM harness_shared\.goals/i.test(s.text));
    expect(del).toBeTruthy();
    expect(del!.values).toContain('ws-test');
  });

  it('deletes the goal and spawns NOTHING when the mode stamp fails', async () => {
    setModeMock.mockImplementation(async (opts: SetModeCall) => {
      setModeCalls.push(opts);
      order.push('mode-set');
      return { ok: false, error: 'sticky conflict' };
    });
    const res = await call();
    expect(isError(res)).toBe(true);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(order).toContain('delete');
  });
});

describe('the pre-pin this tool depends on', () => {
  it('emits --owner-id on a FRESH launch and never on a resume', () => {
    const fresh = buildAgentLaunchCommand({
      mode: 'fresh',
      agent: 'claude',
      harness: 'papercusp',
      ownerId: 'su-abc',
    });
    expect(fresh).toContain('--owner-id=su-abc');
    // A resumed session already HAS an identity; re-pinning would split it from
    // its own history — the pin's purpose inverted.
    const resumed = buildAgentLaunchCommand({
      mode: 'resume',
      sessionId: 'sess-1',
      ownerId: 'su-abc',
    });
    expect(resumed).not.toContain('--owner-id');
  });
});

describe('the kickoff brief', () => {
  it('states the outcome, the kill criterion and the ceiling in dollars', () => {
    const brief = buildGoalKickoffBrief({
      goalId: 'ship-paid-app-3f9a1c',
      title: 'Ship a paid app',
      killCriterion: 'no paying user by day 30',
      budgetCents: 50_000,
    });
    expect(brief).toContain('ship-paid-app-3f9a1c');
    expect(brief).toContain('OUTCOME — Ship a paid app');
    expect(brief).toContain('KILL THIS IF — no paying user by day 30');
    expect(brief).toContain('$500.00');
  });

  it('does not restate the mode contract (which arrives with the mode)', () => {
    const brief = buildGoalKickoffBrief({
      goalId: 'g-1',
      title: 't',
      killCriterion: 'k',
      budgetCents: 0,
    });
    // A second copy of the contract is a second copy to drift; the brief points
    // at the delivered one instead.
    expect(brief).not.toContain('portfolio management');
    expect(brief).toContain('mode contract');
  });

  // ── EI-20185528589678586 ────────────────────────────────────────────────
  // This brief was once delivered ~26h after it was written, to a session that
  // was not the goal's agent and held no `overlay:goal` row. Its two standing
  // claims — that the goal was JUST started, and that the contract HAD been
  // delivered — were both false on arrival, and neither was checkable from the
  // text. These two tests pin the fix: the brief now reports what it knows
  // (when it was written) and makes the rest falsifiable.
  it('stamps when it was written instead of claiming the goal was just started', () => {
    const brief = buildGoalKickoffBrief({
      goalId: 'g-1',
      title: 't',
      writtenAt: new Date('2026-08-10T17:06:00Z'),
    });
    expect(brief).toContain('2026-08-10T17:06:00Z');
    // The failing phrasing: a brief cannot know how long it will sit before it
    // is read, so it must not assert freshness on the reader's behalf.
    expect(brief).not.toContain('just started');
  });

  it('tells a reader holding no contract to STOP, rather than asserting one was delivered', () => {
    const brief = buildGoalKickoffBrief({ goalId: 'g-1', title: 't' });
    // Where to look — an agent can check this in one call and catch the absence.
    expect(brief).toContain('modes[].contract');
    expect(brief).toContain('mode:get');
    expect(brief).toMatch(/STOP/);
    // The unfalsifiable form: a bare statement that it already arrived reads as
    // fact, so an agent that never received one has no cue anything is wrong.
    expect(brief).not.toContain('(delivered with your orient)');
  });
});

// ── EI-20049757392342975 ──────────────────────────────────────────────────
describe('goals:start — the shared kill-criterion rule applies at THIS door too', () => {
  /**
   * This is the door the owner's own HUD composer posts to
   * (GoalComposer → postGoalStart → goals:start), and until now nothing on that
   * whole path enforced the rule — GoalComposer.tsx even renders an
   * `errors.killCriterion` slot that `validateGoalDraft` can never populate.
   * `goals:propose` and `goals:update` both refused a stub; this door and
   * `goals:create` did not, so a criterion could be INSTALLED that could never
   * afterwards be UPDATED to.
   */
  it('refuses a stub criterion, and spawns NOTHING', async () => {
    const res = await call({ killCriterion: 'gut feel' });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/states no abandonment condition/);
    // The load-bearing assertions: refusing must cost no goal row and no agent.
    // A refusal that still spawned would leave an orphan process behind, which
    // is worse than the permissive behaviour it replaced.
    expect(sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text))).toBeFalsy();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('refuses a placeholder opener that clears the length bar', async () => {
    const res = await call({ killCriterion: 'TBD once we see some real numbers' });
    expect(isError(res)).toBe(true);
    // Assert the REASON: this string is long enough, so a bare isError could be
    // some unrelated rejection and this test would never exercise the rule.
    expect(textOf(res)).toMatch(/states no abandonment condition/);
  });

  /**
   * CONTROLS. WI-37604 (owner-directed 2026-08-09) made a criterion OPTIONAL at
   * creation. That overrule is about PRESENCE; this rule is about quality GIVEN
   * presence. Without these two cases, a guard that simply REQUIRED a criterion
   * would pass both tests above while silently re-imposing exactly what the
   * owner removed — and the happy-path suite would not catch it either, because
   * ARGS always supplies one.
   */
  it('still starts a goal with NO criterion at all — WI-37604', async () => {
    const res = await call({ killCriterion: undefined });
    expect(isError(res)).toBe(false);
    expect(sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text))).toBeTruthy();
  });

  it('still starts a goal with a blank criterion', async () => {
    const res = await call({ killCriterion: '   ' });
    expect(isError(res)).toBe(false);
    expect(sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text))).toBeTruthy();
  });
});
