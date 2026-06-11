import { describe, it, expect } from 'vitest';
import { classifyAgentPane, AGENT_PANE_KINDS, DRIVE_MODES } from './agent-pane-kind';
import { AGENT_ROLES } from './role-config';

describe('classifyAgentPane', () => {
  it('brain launch → queen/auto (wins over any role)', () => {
    expect(classifyAgentPane({ launch: 'brain' })).toEqual({ kind: 'queen', driveMode: 'auto' });
    expect(classifyAgentPane({ role: 'operator', launch: 'brain' }).kind).toBe('queen');
  });

  it('the `brain` principal role → queen/auto (active brain entry, no launch hint)', () => {
    // An active roster entry carries the adv_sessions role; the brain session's
    // role is BRAIN_PRINCIPAL_ROLE='brain', so it classifies as queen by role alone.
    expect(classifyAgentPane({ role: 'brain' })).toEqual({ kind: 'queen', driveMode: 'auto' });
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

  it('the registered `queen` role → queen/auto (hive invoke-route launches)', () => {
    expect(classifyAgentPane({ role: 'queen' })).toEqual({ kind: 'queen', driveMode: 'auto' });
  });

  it("the owner's psu sessions → su/responsive, NOT the bee fallback (P-005)", () => {
    // Explicit role.
    expect(classifyAgentPane({ role: 'su' })).toEqual({ kind: 'su', driveMode: 'responsive' });
    // Role-less presence with the psu su- coord-id prefix (the common roster shape).
    expect(classifyAgentPane({ ownerId: 'su-0e3fdf01-144f-48c8-8949-7e8ab88f9501' })).toEqual({
      kind: 'su',
      driveMode: 'responsive',
    });
    // A ROLE-stamped su- owner keeps its role classification (role wins).
    expect(classifyAgentPane({ role: 'worker', ownerId: 'su-abc' }).kind).toBe('bee');
    // Nursery spawn ids (s-<ts>-…) never match the su arm.
    expect(classifyAgentPane({ ownerId: 's-1781144142976-494394ea' }).kind).toBe('bee');
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

  it('exposes exactly the five kinds + two modes', () => {
    expect(AGENT_PANE_KINDS).toEqual(['queen', 'bee', 'sentinel', 'planner', 'su']);
    expect(DRIVE_MODES).toEqual(['auto', 'responsive']);
  });
});
