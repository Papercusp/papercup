/**
 * Wind-down disposition gate — module guard tests (goal-mode-design-intent-
 * hardening-2026-08-16 P-002).
 *
 * The load-bearing assertions:
 *  - the refusal NAMES the missing arg (`disposition`) and ALL THREE legal
 *    values — that wording is the acceptance criterion, because the refused
 *    agent's only way forward is the error text itself;
 *  - disposition → goals.status mapping: achieved/killed flip the row,
 *    handoff leaves it ACTIVE (someone else continues the goal);
 *  - the flag check fails CLOSED (broken flag infra disables the gate) — the
 *    deliberate opposite of drainFleetAutoMintEnabled's fail-open.
 *
 * Falsifiability: the refusal predicate is exercised against a deliberately
 * wrong in-file CONTROL (a refusal that names the arg but not the values), so
 * a test that would accept the control is caught here, not in production.
 *
 * Run: cd packages/operator-core && npx vitest run lib/goals/wind-down-disposition.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modes/store', () => ({ getModeSubject: vi.fn() }));
vi.mock('../agent-tools/coordination/escalations', () => ({ openEscalation: vi.fn(async () => ({})) }));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: vi.fn(() => {
    throw new Error('unit test must inject `sql` explicitly');
  }),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    GOAL_WINDDOWN_DISPOSITION_GATE: 'papercusp-goal-winddown-disposition-gate',
    GOAL_ACHIEVED_ACCEPTANCE_GATE: 'papercusp-goal-achieved-acceptance-gate',
  },
}));

import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import { getFlag } from '@papercusp/flags/server';
import { getModeSubject } from '../modes/store';
import { openEscalation } from '../agent-tools/coordination/escalations';
import {
  GOAL_DISPOSITIONS,
  activeGoalForOwner,
  applyGoalDisposition,
  buildDispositionRefusal,
  buildGoalWindDownReport,
  deliverGoalWindDownReport,
  evaluateGoalAcceptanceGate,
  goalAchievedAcceptanceGateEnabled,
  isGoalDisposition,
  windDownDispositionGateEnabled,
  type GoalAcceptanceCard,
  type GoalAcceptanceGateDeps,
} from './wind-down-disposition';

const getModeSubjectMock = getModeSubject as unknown as ReturnType<typeof vi.fn>;
const openEscalationMock = openEscalation as unknown as ReturnType<typeof vi.fn>;
const getFlagMock = getFlag as unknown as ReturnType<typeof vi.fn>;

/** A recording SQL tag: captures every call's template + values, answers from a queue. */
function recordingSql(rows: unknown[][] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const queue = [...rows];
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('␣'), values });
    return queue.shift() ?? [];
  }) as unknown as GoalSqlTag;
  return { tag, calls };
}

beforeEach(() => {
  getModeSubjectMock.mockReset();
  openEscalationMock.mockReset();
  openEscalationMock.mockResolvedValue({});
  getFlagMock.mockReset();
});

describe('the disposition vocabulary', () => {
  it('is exactly achieved | killed | handoff', () => {
    expect(GOAL_DISPOSITIONS).toEqual(['achieved', 'killed', 'handoff']);
    for (const d of GOAL_DISPOSITIONS) expect(isGoalDisposition(d)).toBe(true);
    expect(isGoalDisposition('paused')).toBe(false);
    expect(isGoalDisposition(undefined)).toBe(false);
  });
});

describe('buildDispositionRefusal — the acceptance wording', () => {
  /** The acceptance predicate, shared with the control below. */
  const namesArgAndAllValues = (refusal: { error: string }) =>
    /\bdisposition\b/.test(refusal.error) &&
    GOAL_DISPOSITIONS.every((d) => refusal.error.includes(`'${d}'`));

  it('names the missing arg AND all three values, for both wind-down verbs', () => {
    for (const action of ['loop:end', 'session:end'] as const) {
      const refusal = buildDispositionRefusal({
        action,
        goalId: 'ship-paid-app-3f9a1c',
        goalTitle: 'Ship the paid app',
      });
      expect(refusal.ok).toBe(false);
      expect(namesArgAndAllValues(refusal)).toBe(true);
      expect(refusal.error).toContain(action);
      expect(refusal.error).toContain('ship-paid-app-3f9a1c');
      expect(refusal.goalId).toBe('ship-paid-app-3f9a1c');
      expect(refusal.dispositions).toEqual(GOAL_DISPOSITIONS);
    }
  });

  it('CONTROL: the predicate rejects a refusal that names the arg but not the values', () => {
    // Deliberately-wrong control implementation, kept permanently: proves the
    // predicate above can fail, so a green run means the real wording earned it.
    const control = { error: 'REFUSED — pass a disposition and retry.' };
    expect(namesArgAndAllValues(control)).toBe(false);
    const controlMissingArg = { error: "Pass 'achieved', 'killed' or 'handoff'." };
    expect(namesArgAndAllValues(controlMissingArg)).toBe(false);
  });
});

describe('buildGoalWindDownReport', () => {
  const base = {
    goalId: 'g-1',
    goalTitle: 'Ship the paid app',
    endedBy: 'su-abc',
    action: 'loop:end' as const,
  };

  it('folds the end reason AND the final carry-note into the body', () => {
    const { summary, body } = buildGoalWindDownReport({
      ...base,
      disposition: 'achieved',
      reason: 'all 13 items shipped',
      carryNote: '## Did\neverything\n## Left\nnothing',
    });
    expect(summary).toContain('achieved');
    expect(summary).toContain('Ship the paid app');
    expect(body).toContain('all 13 items shipped');
    expect(body).toContain('## Final carry-note');
    expect(body).toContain('everything');
    expect(body).toContain('loop:end');
  });

  it('handoff reads as a continuation, not an ending, and names the successor', () => {
    const { summary, body } = buildGoalWindDownReport({
      ...base,
      disposition: 'handoff',
      handoffTo: 'su-next',
    });
    expect(summary).toContain('handoff');
    expect(summary).toContain('su-next');
    expect(summary).toContain('stays active');
    expect(body).toContain('su-next');
  });

  it('says explicitly when there was no reason and no carry-note, instead of an empty body', () => {
    const { body } = buildGoalWindDownReport({ ...base, disposition: 'killed' });
    expect(body).toMatch(/No end reason or carry-note/);
  });
});

describe('applyGoalDisposition — disposition → goals.status mapping', () => {
  it.each([
    ['achieved', 'achieved'],
    ['killed', 'killed'],
  ] as const)('%s flips goals.status to %s', async (disposition, expectedStatus) => {
    const { tag, calls } = recordingSql();
    await applyGoalDisposition({
      workspaceId: 'ws-1',
      goalId: 'g-1',
      disposition,
      dispositionBy: 'su-abc',
      sql: tag,
    });
    expect(calls).toHaveLength(1);
    // COALESCE(${nextStatus}::text, status): the first value IS the new status.
    expect(calls[0].values[0]).toBe(expectedStatus);
    const stamp = JSON.parse(String(calls[0].values[1])) as Record<string, unknown>;
    expect(stamp.disposition).toBe(disposition);
    expect(stamp.dispositionBy).toBe('su-abc');
    expect(typeof stamp.dispositionAt).toBe('string');
    // Multi-tenant scoping: id AND workspace ride the WHERE.
    expect(calls[0].values).toContain('g-1');
    expect(calls[0].values).toContain('ws-1');
  });

  it('handoff leaves goals.status untouched (null into COALESCE) and stamps handoffTo', async () => {
    const { tag, calls } = recordingSql();
    await applyGoalDisposition({
      workspaceId: 'ws-1',
      goalId: 'g-1',
      disposition: 'handoff',
      dispositionBy: 'su-abc',
      handoffTo: 'su-next',
      sql: tag,
    });
    expect(calls[0].values[0]).toBeNull();
    const stamp = JSON.parse(String(calls[0].values[1])) as Record<string, unknown>;
    expect(stamp.disposition).toBe('handoff');
    expect(stamp.handoffTo).toBe('su-next');
  });
});

describe('activeGoalForOwner — positive-finding-only resolution', () => {
  it('returns null (and never queries goals) when the owner is not in GOAL mode', async () => {
    getModeSubjectMock.mockResolvedValue(null);
    const { tag, calls } = recordingSql();
    const got = await activeGoalForOwner({ workspaceId: 'ws-1', ownerId: 'su-abc', sql: tag });
    expect(got).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns the goal ref (with any recorded disposition) for an active goal', async () => {
    getModeSubjectMock.mockResolvedValue('g-1');
    const { tag } = recordingSql([
      [{ id: 'g-1', title: 'Ship it', install_slug: 'papercusp', disposition: null }],
    ]);
    const got = await activeGoalForOwner({ workspaceId: 'ws-1', ownerId: 'su-abc', sql: tag });
    expect(got).toEqual({
      goalId: 'g-1',
      title: 'Ship it',
      installSlug: 'papercusp',
      recordedDisposition: null,
    });
  });

  it('returns null when the goal row is no longer active (already achieved/killed/paused)', async () => {
    getModeSubjectMock.mockResolvedValue('g-1');
    const { tag } = recordingSql([[]]);
    const got = await activeGoalForOwner({ workspaceId: 'ws-1', ownerId: 'su-abc', sql: tag });
    expect(got).toBeNull();
  });

  it('treats a mode-subject read error as "no goal" — resolution misses never refuse', async () => {
    getModeSubjectMock.mockRejectedValue(new Error('pg down'));
    const { tag, calls } = recordingSql();
    const got = await activeGoalForOwner({ workspaceId: 'ws-1', ownerId: 'su-abc', sql: tag });
    expect(got).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('deliverGoalWindDownReport — the owner inbox surface', () => {
  it('opens an advisory escalation deduped per goal', async () => {
    const identity = { ownerId: 'su-abc', ownerLabel: 'su · abc' };
    await deliverGoalWindDownReport(identity as never, {
      workspaceId: 'ws-1',
      goalId: 'g-1',
      disposition: 'achieved',
      summary: 'Goal wind-down [achieved]: Ship it',
      body: 'the report',
    });
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const [gotIdentity, input] = openEscalationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(gotIdentity).toBe(identity);
    expect(input.severity).toBe('advisory');
    const meta = input.meta as Record<string, unknown>;
    expect(meta.dedupKind).toBe('goal-wind-down');
    expect(meta.subjectSignature).toBe('ws-1:g-1');
  });
});

describe('windDownDispositionGateEnabled — FAIL-CLOSED', () => {
  it('reflects the flag when the read works', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await windDownDispositionGateEnabled()).toBe(true);
    getFlagMock.mockResolvedValue(false);
    expect(await windDownDispositionGateEnabled()).toBe(false);
  });

  it('disables the gate on flag-infra errors — a refusal gate must never wedge the stop path', async () => {
    getFlagMock.mockRejectedValue(new Error('flag store unreachable'));
    expect(await windDownDispositionGateEnabled()).toBe(false);
  });
});
