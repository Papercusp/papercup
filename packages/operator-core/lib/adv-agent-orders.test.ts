/**
 * Unit tests for the PURE half of adv-agent-orders
 * (session-chat-popup-direction-d-2026-08-02 P-011/P-012).
 *
 * The IO half (`getAgentOrders`) composes four existing authorities and is
 * covered by their own suites; what is genuinely new logic — and therefore
 * genuinely worth testing — is the grading and flattening below.
 */
import { describe, expect, it } from 'vitest';
import { carryStaleness, missionFromTrace, renderRoute } from './adv-agent-orders';

describe('carryStaleness', () => {
  it('grades a cold agent harder than a warm one at the SAME age', () => {
    // The whole point of the function: for a cold-carry agent the checkpoint is
    // its only memory across wakes, so an age that is unremarkable for a warm
    // agent is a correctness problem for a cold one. Asserted at two points so
    // the test pins the SHAPE of the difference, not one lucky threshold.
    expect(carryStaleness(10 * 60_000, 'cold')).toBe('aging');
    expect(carryStaleness(10 * 60_000, 'warm')).toBe('fresh');

    expect(carryStaleness(30 * 60_000, 'cold')).toBe('stale');
    expect(carryStaleness(30 * 60_000, 'warm')).toBe('aging');
  });

  it('walks cold through fresh → aging → stale', () => {
    expect(carryStaleness(2 * 60_000, 'cold')).toBe('fresh');
    expect(carryStaleness(10 * 60_000, 'cold')).toBe('aging');
    expect(carryStaleness(60 * 60_000, 'cold')).toBe('stale');
  });

  it('walks warm through fresh → aging → stale', () => {
    expect(carryStaleness(5 * 60_000, 'warm')).toBe('fresh');
    expect(carryStaleness(45 * 60_000, 'warm')).toBe('aging');
    expect(carryStaleness(4 * 60 * 60_000, 'warm')).toBe('stale');
  });

  it('returns unknown rather than guessing when the age is unusable', () => {
    // An unknown age must NOT render as "fresh" — that is the failure mode the
    // three-state rule (plan D-003) exists to prevent, in miniature.
    expect(carryStaleness(null, 'warm')).toBe('unknown');
    expect(carryStaleness(Number.NaN, 'cold')).toBe('unknown');
    expect(carryStaleness(-1, 'warm')).toBe('unknown');
  });

  it('treats an unknown carry mode as warm rather than failing', () => {
    expect(carryStaleness(10 * 60_000, null)).toBe('fresh');
  });
});

describe('renderRoute', () => {
  it('renders a fleet route with its role', () => {
    expect(renderRoute({ kind: 'fleet', fleet: 'hud-redesign', role: 'leader' })).toBe(
      'fleet:hud-redesign (leader)',
    );
  });

  it('renders a fleet route without a role', () => {
    expect(renderRoute({ kind: 'fleet', fleet: 'hud-redesign', role: null })).toBe(
      'fleet:hud-redesign',
    );
  });

  it('renders non-fleet routes as their bare kind', () => {
    expect(renderRoute({ kind: 'self' })).toBe('self');
    expect(renderRoute({ kind: 'mug' })).toBe('mug');
  });

  it('does not claim a fleet when the slug is missing', () => {
    // A malformed route must degrade, never render "fleet:undefined".
    expect(renderRoute({ kind: 'fleet' })).toBe('fleet');
  });
});

describe('missionFromTrace', () => {
  const trace = {
    effectiveMission: {
      constraint: 'execute-owner-directed-scope',
      source: 'route:self',
      explanation: 'Advance the current owner-directed task.',
    },
    decisions: [
      {
        key: 'execution-authorization',
        status: 'effective',
        effective: { value: 'confirm-before-execution', source: 'generic-playbook' },
        suppressed: [],
      },
      {
        key: 'mission',
        status: 'effective',
        effective: { value: 'execute-owner-directed-scope', source: 'route:self' },
        suppressed: [
          {
            value: 'generic-backlog-selection',
            source: 'generic-playbook',
            reason: 'owner-directed scope is the effective mission.',
          },
        ],
      },
    ],
  };

  it('lifts the mission, the authority, and the route', () => {
    const m = missionFromTrace(trace, 'self');
    expect(m?.constraint).toBe('execute-owner-directed-scope');
    expect(m?.authority).toBe('confirm-before-execution');
    expect(m?.authoritySource).toBe('generic-playbook');
    expect(m?.route).toBe('self');
  });

  it('collects suppressions from EVERY decision, tagged with their key', () => {
    // The panel's whole reason for showing suppressions is that a suppressed
    // rule is indistinguishable from a disobeyed one without them — so they
    // must not be dropped just because they live under a non-authority key.
    const m = missionFromTrace(trace, 'self');
    expect(m?.suppressed).toHaveLength(1);
    expect(m?.suppressed[0]).toMatchObject({
      key: 'mission',
      value: 'generic-backlog-selection',
    });
    expect(m?.suppressed[0]?.reason).toContain('owner-directed');
  });

  it('returns null for a missing trace rather than a fabricated default', () => {
    // Rendering a default "confirm-before-execution" for an agent whose trace we
    // could not read would be a false statement about its authority — worse
    // than an honest blank.
    expect(missionFromTrace(null, 'self')).toBeNull();
    expect(missionFromTrace(undefined, 'self')).toBeNull();
  });

  it('survives a trace with no decisions at all', () => {
    const m = missionFromTrace({ effectiveMission: { constraint: 'x' } }, null);
    expect(m?.constraint).toBe('x');
    expect(m?.authority).toBeNull();
    expect(m?.suppressed).toEqual([]);
  });
});
