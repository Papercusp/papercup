/**
 * WI-1912: the `states` arg on the pull tools (scheduler:get_next /
 * work_items:claim_next) must not widen past the resolver-owned floors.
 *
 * A backlog-clearance fleet member passed states:['todo','open','blocked'] and
 * get_next surfaced WI-1591 — a `blocked`, leader-triage-only item — into their
 * pull loop. The claim-spec validator rejects a `blocked` filter TERM precisely
 * so a spec can never un-floor itself (D-002), but the sibling free-string
 * `states` arg re-opened the identical hole at the tool boundary. These tests
 * pin the clamp: `states` accepts only CLAIM_STATES_ALLOWLIST members.
 */
import { describe, it, expect } from 'vitest';
import type { ZodTypeAny } from 'zod';
import getNextTool from './get_next';
import claimNextTool from '../work_items/claim_next';
import { CLAIM_STATES_ALLOWLIST } from '../../work-items';

const TOOLS: Array<{ name: string; args: ZodTypeAny }> = [
  { name: 'scheduler:get_next', args: (getNextTool as { args: ZodTypeAny }).args },
  { name: 'work_items:claim_next', args: (claimNextTool as { args: ZodTypeAny }).args },
];

describe('pull-tool `states` arg is clamped to the claimable allowlist (WI-1912)', () => {
  it('exposes the expected allowlist (todo/open/failing — floors + terminals excluded)', () => {
    expect([...CLAIM_STATES_ALLOWLIST]).toEqual(['todo', 'open', 'failing']);
  });

  it('accepts every allowlisted state', () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp', states: [...CLAIM_STATES_ALLOWLIST] });
      expect(r.success, `${name} should accept states:${JSON.stringify(CLAIM_STATES_ALLOWLIST)}`).toBe(true);
    }
  });

  it('accepts an omitted `states` (the ["todo"] default)', () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp' });
      expect(r.success, `${name} should accept omitted states`).toBe(true);
    }
  });

  it('REJECTS floor-protected and terminal states — the WI-1912 widening', () => {
    for (const { name, args } of TOOLS) {
      for (const bad of ['blocked', 'cursed', 'in_progress', 'passed', 'resolved', 'closed', 'deprecated', 'needs-human']) {
        const r = args.safeParse({ harness: 'papercusp', states: ['todo', bad] });
        expect(r.success, `${name} must reject states:['todo','${bad}']`).toBe(false);
      }
    }
  });

  it("REJECTS the exact observed widening args (states:['todo','open','blocked'])", () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp', states: ['todo', 'open', 'blocked'] });
      expect(r.success, `${name} must reject the WI-1912 repro args`).toBe(false);
    }
  });
});
