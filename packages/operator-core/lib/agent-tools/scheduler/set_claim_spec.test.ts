/**
 * Unit tests for the inert-spec advisory (set_claim_spec.ts).
 *
 * su-loop-capability-parity-2026-07-03 P-003(b): the advisory used to warn 'INERT spec'
 * for ANY spawned role that wasn't in {bee, queen} — a FALSE-POSITIVE on every SU fleet
 * member (which, post-P-001, self-pulls via scheduler:get_next). The fix inverts the check
 * to an allowlist of the coding-FACTORY push-pipeline roles, so ONLY a genuine factory
 * push-role trips it. These assertions pin that role-awareness.
 */
import { describe, it, expect } from 'vitest';
import { claimSpecInertWarning, claimSpecWakeabilityWarning } from './set_claim_spec';

describe('claimSpecInertWarning — inert-spec advisory role-awareness', () => {
  it('WARNS for coding-FACTORY push-pipeline roles (spec is genuinely inert)', () => {
    for (const role of [
      'scoper',
      'architect',
      'worker',
      'validator',
      'reviewer',
      'debugger',
      'documenter',
      'curator',
      'director',
    ]) {
      const w = claimSpecInertWarning('bee-x', role);
      expect(w, `expected a warning for factory role "${role}"`).toBeTruthy();
      expect(w).toContain(role);
      expect(w).toContain('INERT');
    }
  });

  it('does NOT warn for self-pulling hive roles (bee / queen)', () => {
    expect(claimSpecInertWarning('bee-1', 'bee')).toBeNull();
    expect(claimSpecInertWarning('queen-1', 'queen')).toBeNull();
  });

  it('does NOT warn for an su fleet member — the P-003 false-positive class', () => {
    // A fleet member launched via launch-on-plan runs as a bare su collaborator; the
    // nursery records no distinctive self-pulling role (often null or a bare role string),
    // yet post-P-001 it self-pulls via get_next. None of these may trip the advisory.
    expect(claimSpecInertWarning('su-member', null)).toBeNull();
    expect(claimSpecInertWarning('su-member', '(missing)')).toBeNull();
    expect(claimSpecInertWarning('su-member', 'su')).toBeNull();
    expect(claimSpecInertWarning('su-member', 'operator')).toBeNull();
  });

  it('does NOT warn when the spawned role is unknown/null (best-effort, never cries wolf)', () => {
    expect(claimSpecInertWarning('x', null)).toBeNull();
    expect(claimSpecInertWarning('x', '')).toBeNull();
    expect(claimSpecInertWarning('x', 'some-future-role')).toBeNull();
  });

  it('names the beeId in the warning so the operator can act on it', () => {
    const w = claimSpecInertWarning('bee-abc123', 'scoper');
    expect(w).toContain('bee-abc123');
  });
});
