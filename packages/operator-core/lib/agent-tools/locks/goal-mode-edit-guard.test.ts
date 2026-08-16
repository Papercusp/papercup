/**
 * goal-mode-edit-guard — the GOAL contract's never-implement clause as a
 * mechanical gate (EI-20581099901890760).
 *
 * Falsifiability: alongside the real guard, `alwaysAllowControl` is a
 * deliberately-wrong implementation kept permanently as a control — the
 * calibration cases assert the REAL guard catches what the control misses,
 * so a broken property makes the control cases fail too.
 */
import { describe, expect, it } from 'vitest';
import { checkGoalModeEditGuard, goalModeEditDenyReason } from './goal-mode-edit-guard';

const flagOn = () => Promise.resolve(true);
const flagOff = () => Promise.resolve(false);
const goalModes = async () => [{ mode: 'auto' }, { mode: 'goal' }];
const plainModes = async () => [{ mode: 'auto' }, { mode: 'ideate' }];
const noModes = async () => [];

/** Deliberately-wrong control: a guard that never denies. */
async function alwaysAllowControl(): Promise<string | null> {
  return null;
}

describe('checkGoalModeEditGuard', () => {
  it('denies an automatic edit claim from a GOAL-mode session, with the teaching reason', async () => {
    const reason = await checkGoalModeEditGuard(
      { workspaceId: 'papercusp-workspace', ownerId: 'su-goal-1', intent: 'PreToolUse:Edit' },
      { flagEnabled: flagOn, readModes: goalModes },
    );
    expect(reason).toBe(goalModeEditDenyReason({ ownerId: 'su-goal-1' }));
    expect(reason).toMatch(/never implement/i);
    expect(reason).toMatch(/work_items:create/);
    expect(reason).toMatch(/fleet:launch-on-plan/);
    // Calibration: the wrong control would have allowed this exact case.
    expect(await alwaysAllowControl()).toBeNull();
  });

  it('denies PreToolUse:Write the same as Edit', async () => {
    const reason = await checkGoalModeEditGuard(
      { workspaceId: 'ws', ownerId: 'su-goal-1', intent: 'PreToolUse:Write' },
      { flagEnabled: flagOn, readModes: goalModes },
    );
    expect(reason).not.toBeNull();
  });

  it('allows a session with modes but no goal row (a fleet member inheriting goal CONTEXT holds no mode row)', async () => {
    const reason = await checkGoalModeEditGuard(
      { workspaceId: 'ws', ownerId: 'su-member-1', intent: 'PreToolUse:Edit' },
      { flagEnabled: flagOn, readModes: plainModes },
    );
    expect(reason).toBeNull();
  });

  it('allows a session with no modes at all', async () => {
    const reason = await checkGoalModeEditGuard(
      { workspaceId: 'ws', ownerId: 'su-plain-1', intent: 'PreToolUse:Edit' },
      { flagEnabled: flagOn, readModes: noModes },
    );
    expect(reason).toBeNull();
  });

  it('allows a deliberate hand-held (non-hook) lock even in GOAL mode — only automatic edit claims are gated', async () => {
    const reason = await checkGoalModeEditGuard(
      { workspaceId: 'ws', ownerId: 'su-goal-1', intent: 'multi-file refactor of complete.ts' },
      { flagEnabled: flagOn, readModes: goalModes },
    );
    expect(reason).toBeNull();
  });

  it('allows when the flag is OFF (kill-switch)', async () => {
    const reason = await checkGoalModeEditGuard(
      { workspaceId: 'ws', ownerId: 'su-goal-1', intent: 'PreToolUse:Edit' },
      { flagEnabled: flagOff, readModes: goalModes },
    );
    expect(reason).toBeNull();
  });

  it('fails OPEN when the mode read throws (enforcement must never wedge edits)', async () => {
    const reason = await checkGoalModeEditGuard(
      { workspaceId: 'ws', ownerId: 'su-goal-1', intent: 'PreToolUse:Edit' },
      {
        flagEnabled: flagOn,
        readModes: async () => {
          throw new Error('pg down');
        },
      },
    );
    expect(reason).toBeNull();
  });

  it('fails OPEN when the flag read throws', async () => {
    const reason = await checkGoalModeEditGuard(
      { workspaceId: 'ws', ownerId: 'su-goal-1', intent: 'PreToolUse:Edit' },
      {
        flagEnabled: async () => {
          throw new Error('flag infra down');
        },
        readModes: goalModes,
      },
    );
    expect(reason).toBeNull();
  });

  it('null workspace falls back to the default workspace rather than allowing blind', async () => {
    let asked: string | null = null;
    const reason = await checkGoalModeEditGuard(
      { workspaceId: null, ownerId: 'su-goal-1', intent: 'PreToolUse:Edit' },
      {
        flagEnabled: flagOn,
        readModes: async (ws) => {
          asked = ws;
          return goalModes();
        },
      },
    );
    expect(asked).toBe('default');
    expect(reason).not.toBeNull();
  });
});
