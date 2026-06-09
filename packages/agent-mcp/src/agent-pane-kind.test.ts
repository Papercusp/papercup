import { describe, it, expect } from 'vitest';
import { classifyAgentPane, AGENT_PANE_KINDS, DRIVE_MODES } from './agent-pane-kind';
import { AGENT_ROLES } from './role-config';

describe('classifyAgentPane', () => {
  it('brain launch → queen/auto (wins over any role)', () => {
    expect(classifyAgentPane({ launch: 'brain' })).toEqual({ kind: 'queen', driveMode: 'auto' });
    expect(classifyAgentPane({ role: 'operator', launch: 'brain' }).kind).toBe('queen');
  });

  it('operator role → sentinel/responsive (the owner-facing persona)', () => {
    expect(classifyAgentPane({ role: 'operator' })).toEqual({
      kind: 'sentinel',
      driveMode: 'responsive',
    });
  });

  it('the `sentinel` WATCHER role is a bee, NOT the Sentinel pane (collision guard, D-001/D-007)', () => {
    // The owner-facing "Sentinel" tab is the operator persona; the `sentinel`
    // ROLE is the read-mostly fleet watcher → an autonomous bee.
    expect(classifyAgentPane({ role: 'sentinel' })).toEqual({ kind: 'bee', driveMode: 'auto' });
  });

  it('pipeline + generic + cross-cutting roles → bee/auto', () => {
    for (const r of ['worker', 'validator', 'scoper', 'reviewer', 'curator', 'bee', 'orchestrator', 'auditor']) {
      expect(classifyAgentPane({ role: r })).toEqual({ kind: 'bee', driveMode: 'auto' });
    }
  });

  it('planner launch or role → planner/responsive', () => {
    expect(classifyAgentPane({ launch: 'planner' })).toEqual({
      kind: 'planner',
      driveMode: 'responsive',
    });
    expect(classifyAgentPane({ role: 'planner' }).kind).toBe('planner');
  });

  it('oracle → sentinel/responsive (responsive chat)', () => {
    expect(classifyAgentPane({ role: 'oracle' })).toEqual({
      kind: 'sentinel',
      driveMode: 'responsive',
    });
  });

  it('unknown / empty role → bee/auto default', () => {
    expect(classifyAgentPane({})).toEqual({ kind: 'bee', driveMode: 'auto' });
    expect(classifyAgentPane({ role: '   ' }).kind).toBe('bee');
    expect(classifyAgentPane({ role: null }).kind).toBe('bee');
  });

  it('case-insensitive on role', () => {
    expect(classifyAgentPane({ role: 'OPERATOR' }).kind).toBe('sentinel');
  });

  it('every built-in role classifies to a known kind + mode (total function)', () => {
    for (const r of AGENT_ROLES) {
      const c = classifyAgentPane({ role: r });
      expect(AGENT_PANE_KINDS).toContain(c.kind);
      expect(DRIVE_MODES).toContain(c.driveMode);
    }
  });

  it('exposes exactly the four kinds + two modes', () => {
    expect(AGENT_PANE_KINDS).toEqual(['queen', 'bee', 'sentinel', 'planner']);
    expect(DRIVE_MODES).toEqual(['auto', 'responsive']);
  });
});
