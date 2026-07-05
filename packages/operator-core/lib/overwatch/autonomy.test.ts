import { describe, it, expect } from 'vitest';
import {
  classifyOverwatchAction,
  decideOverwatchAutonomy,
  OVERWATCH_AUTO_VERBS,
  type OverwatchActionClass,
} from './autonomy';

// B-06: the overwatch DECISION gate / autonomy envelope (D-002). Pure, no IO.
// auto = nudge (coord:send / messages:send) · observe (improvements:capture) ·
// escalate (coord:escalate); everything else = structural ⇒ gated, escalate-only.
describe('overwatch autonomy gate (B-06 / D-002)', () => {
  describe('classifyOverwatchAction', () => {
    const cases: Array<[string, OverwatchActionClass]> = [
      ['coord:send', 'nudge'],
      ['messages:send', 'nudge'],
      ['improvements:capture', 'observe'],
      ['coord:escalate', 'escalate'],
      // EI-3588: overwatch's own wake-scheduling bookkeeping — never structural
      ['kettle:declare-wake', 'lifecycle'],
      // structural — the D-002 escalate-only bucket
      ['routines:write', 'structural'],
      ['flags:set', 'structural'],
      ['processes:kill', 'structural'],
      ['dev:restart', 'structural'],
      ['autoloop:control', 'structural'],
      ['deploy:harness', 'structural'],
      // D-001: overwatch never re-places / spawns work
      ['cup:spawn', 'structural'],
      ['work_items:set_priority', 'structural'],
      // unmapped verb ⇒ fail-safe structural
      ['totally:unknown', 'structural'],
    ];
    it.each(cases)('classifies %s → %s', (action, expected) => {
      expect(classifyOverwatchAction(action)).toBe(expected);
    });

    it('normalizes case, whitespace, and a "." separator', () => {
      expect(classifyOverwatchAction('  COORD:SEND  ')).toBe('nudge');
      expect(classifyOverwatchAction('coord.send')).toBe('nudge');
      expect(classifyOverwatchAction('Improvements:Capture')).toBe('observe');
    });
  });

  describe('decideOverwatchAutonomy', () => {
    it('AUTO-decides a nudge (coord:send)', () => {
      const d = decideOverwatchAutonomy({ action: 'coord:send' });
      expect(d.posture).toBe('auto');
      expect(d.actionClass).toBe('nudge');
      expect(d.escalateOnly).toBe(false);
      expect(d.action).toBe('coord:send');
      expect(d.reasons).toContain('overwatch-auto:nudge');
    });

    it('AUTO-decides messages:send (the other nudge verb)', () => {
      const d = decideOverwatchAutonomy({ action: 'messages:send' });
      expect(d.posture).toBe('auto');
      expect(d.actionClass).toBe('nudge');
    });

    it('AUTO-decides an observation (improvements:capture)', () => {
      const d = decideOverwatchAutonomy({ action: 'improvements:capture' });
      expect(d.posture).toBe('auto');
      expect(d.actionClass).toBe('observe');
      expect(d.reasons).toContain('overwatch-auto:observe');
    });

    it('AUTO-decides an escalation (coord:escalate)', () => {
      const d = decideOverwatchAutonomy({ action: 'coord:escalate' });
      expect(d.posture).toBe('auto');
      expect(d.actionClass).toBe('escalate');
      expect(d.reasons).toContain('overwatch-auto:escalate');
    });

    it('AUTO-decides its own wake-scheduling bookkeeping (kettle:declare-wake, EI-3588)', () => {
      const d = decideOverwatchAutonomy({ action: 'kettle:declare-wake' });
      expect(d.posture).toBe('auto');
      expect(d.actionClass).toBe('lifecycle');
      expect(d.escalateOnly).toBe(false);
      expect(d.reasons).toContain('overwatch-auto:lifecycle');
    });

    it('GATES a structural change (restart a routine) as escalate-only', () => {
      const d = decideOverwatchAutonomy({ action: 'routines:write' });
      expect(d.posture).toBe('gated');
      expect(d.actionClass).toBe('structural');
      expect(d.escalateOnly).toBe(true);
      expect(d.reasons).toEqual(['overwatch-structural-action', 'escalate-only']);
    });

    it.each(['flags:set', 'processes:kill', 'dev:restart', 'cup:spawn', 'deploy:harness'])(
      'GATES the structural verb %s (escalate-only)',
      (action) => {
        const d = decideOverwatchAutonomy({ action });
        expect(d.posture).toBe('gated');
        expect(d.escalateOnly).toBe(true);
      },
    );

    it('GATES an unmapped verb (fail-safe)', () => {
      const d = decideOverwatchAutonomy({ action: 'something:weird' });
      expect(d.posture).toBe('gated');
      expect(d.actionClass).toBe('structural');
      expect(d.escalateOnly).toBe(true);
    });
  });

  describe('OVERWATCH_AUTO_VERBS contract (B-11 anchor)', () => {
    it('is exactly the C-2 write surface (nudge/observe/escalate) plus its own lifecycle bookkeeping (EI-3588), sorted', () => {
      expect([...OVERWATCH_AUTO_VERBS]).toEqual(
        ['coord:escalate', 'coord:send', 'improvements:capture', 'kettle:declare-wake', 'messages:send'],
      );
    });

    it('every auto verb decides auto; nothing outside it does', () => {
      for (const v of OVERWATCH_AUTO_VERBS) {
        expect(decideOverwatchAutonomy({ action: v }).posture).toBe('auto');
      }
      // the structural mirror of the capability wall (B-01): non-allowlisted ⇒ gated
      for (const v of ['flags:set', 'routines:write', 'processes:kill', 'cup:spawn']) {
        expect(decideOverwatchAutonomy({ action: v }).posture).toBe('gated');
      }
    });
  });
});
