/**
 * Regression guard for tool-contract-repair-2026-09-05 P-005 (the loop family).
 *
 * Each `it` below pins ONE repair that closed filings in that lane. The lane's
 * value is self-reproducing prevention: every filing was a caller who guessed a
 * name a reasonable person would guess, so an accidental revert re-opens the
 * class rather than failing loudly on its own.
 *
 * These assert against the tools' REAL parsed argument schemas — never a
 * substring match on a rendered schema summary, which is the false negative the
 * plan's standing rules call out (a `one-of` group hides a declared field from a
 * text search, and the miss looks exactly like a clean result).
 */
import { describe, expect, it } from 'vitest';
import { coerceWallRowShape } from '../../carry-note';
import type { CarryArgRepair } from '../../carry-note';
import loopArm from './arm';
import loopCheckpoint from './checkpoint';
import loopEnd from './end';
import loopStatus from './status';

/** Parse through the tool's own declared arg schema, as the dispatcher does. */
function parseArgs(tool: { args: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } } }, value: unknown) {
  return tool.args.safeParse(value);
}

describe('P-005 loop family — argument contract repairs', () => {
  describe('loop:status / loop:end accept `harness` (the largest fingerprint in the lane)', () => {
    // ~29 filings, all "Unrecognized key: harness; accepts only ownerId". Loops are
    // keyed by owner, so the value cannot change the answer — accepted and ignored.
    it('loop:status accepts harness', () => {
      const parsed = parseArgs(loopStatus, { harness: 'papercusp' });
      expect(parsed.success).toBe(true);
    });

    it('loop:end accepts harness', () => {
      const parsed = parseArgs(loopEnd, { harness: 'papercusp' });
      expect(parsed.success).toBe(true);
    });

    it('the accepted `harness` is declared, not silently swallowed by a loose schema', () => {
      // The distinction that makes the assertion above meaningful: an undeclared key
      // must still be REFUSED, which is the loud behaviour the plan preserves.
      const parsed = parseArgs(loopStatus, { harnesss: 'papercusp' });
      expect(parsed.success).toBe(false);
    });
  });

  describe('loop:status accepts `owner` as an alias for `ownerId` (EI-21206535634211412)', () => {
    it('accepts owner', () => {
      const parsed = parseArgs(loopStatus, { owner: 'su-abc' });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { owner?: string }).owner).toBe('su-abc');
    });

    it('still refuses a key that is neither', () => {
      expect(parseArgs(loopStatus, { ownerid: 'su-abc' }).success).toBe(false);
    });
  });

  describe('loop:arm — the carry-only retune the continuation guidance prescribes', () => {
    // The plan named this the clearest GUIDANCE defect in the set: loop:checkpoint's
    // continuation prose told callers to run `loop:arm { carry: 'cold' }`, which the
    // schema then rejected for missing intervalSec/goal — a tool prescribing a call
    // that cannot succeed. ~7 filings.
    it('accepts a carry-only retune with no intervalSec and no goal', () => {
      const parsed = parseArgs(loopArm, { carry: 'cold' });
      expect(parsed.success).toBe(true);
    });

    it('accepts a bare-string blockedOn, mapping it to { reason } (EI-21266013579763384)', () => {
      const parsed = parseArgs(loopArm, { carry: 'cold', blockedOn: 'green gate red, blocking every deploy' });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { blockedOn?: { reason?: string } }).blockedOn).toEqual({
        reason: 'green gate red, blocking every deploy',
      });
    });

    it('an empty bare-string blockedOn still fails on reason.min(1), not on the shape', () => {
      // The repair must not convert a real problem into a silently-accepted empty
      // blocker: routing it through means the schema names the actual fault.
      expect(parseArgs(loopArm, { carry: 'cold', blockedOn: '' }).success).toBe(false);
    });

    it('an object blockedOn is untouched by the preprocessor', () => {
      const parsed = parseArgs(loopArm, {
        carry: 'cold',
        blockedOn: { reason: 'gate red', event: 'gate:green' },
      });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { blockedOn?: { event?: string } }).blockedOn?.event).toBe('gate:green');
    });
  });

  describe('loop:checkpoint — the aliases that close the `checkpoint`/row-shape filings', () => {
    it('accepts the `checkpoint` key as a string alias for `note`', () => {
      // ~9 filings across 6 fingerprints: callers mirror work_items:checkpoint's
      // { id, checkpoint } shape onto this tool.
      expect(parseArgs(loopCheckpoint, { checkpoint: 'carry state' }).success).toBe(true);
    });

    it('accepts keyInsight / nextAction / goal as carry-field aliases', () => {
      expect(parseArgs(loopCheckpoint, { keyInsight: 'a', nextAction: 'b' }).success).toBe(true);
      expect(parseArgs(loopCheckpoint, { goal: 'c' }).success).toBe(true);
    });

    it('accepts a walls row written with `description` instead of `claim`', () => {
      // EI-20256358119840421 / EI-21123164129476823: the byte-identical key was
      // already accepted on a CHECKS row, so the rejection was an asymmetry inside
      // one tool's own two row types, not a contract.
      const parsed = parseArgs(loopCheckpoint, { walls: [{ description: 'owner must arm capital' }] });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { walls?: { claim?: string }[] }).walls?.[0]?.claim).toBe('owner must arm capital');
    });

    it('accepts a walls row written with `key` instead of `id`', () => {
      const parsed = parseArgs(loopCheckpoint, { walls: [{ key: 'w1', claim: 'owner sign-off' }] });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { walls?: { id?: string }[] }).walls?.[0]?.id).toBe('w1');
    });

    it('accepts a checks row written with `description`', () => {
      const parsed = parseArgs(loopCheckpoint, { checks: [{ description: 'suite green' }] });
      expect(parsed.success).toBe(true);
      expect((parsed.data as { checks?: { claim?: string }[] }).checks?.[0]?.claim).toBe('suite green');
    });
  });

  describe('the walls repair is the ALIAS half only — WI-7264 stays in force', () => {
    // WI-7264 decided walls must NOT get the {status, evidence} coercion: a wall has
    // no `verified` field, so mapping `evidence` would have to DROP the caller's data
    // (EI-18723223344390510). If a future change routes walls through the full
    // coerceCarryRowShape, this test is what catches it.
    it('coerceWallRowShape leaves status/evidence alone so the row still fails loudly', () => {
      const repairs: CarryArgRepair[] = [];
      const out = coerceWallRowShape({ claim: 'x', status: 'verified', evidence: 'ran it' }, 'walls[0]', repairs);
      expect(out).toEqual({ claim: 'x', status: 'verified', evidence: 'ran it' });
      expect(repairs).toHaveLength(0);
    });

    it('a walls row carrying evidence is still refused by the schema', () => {
      expect(parseArgs(loopCheckpoint, { walls: [{ claim: 'x', evidence: 'ran it' }] }).success).toBe(false);
    });

    it('coerceWallRowShape does not treat `kind` as a claim alias for walls', () => {
      // coerceCarryRowShape documents this exclusion for owner-gated walls; the
      // narrow wall coercer must not quietly widen it.
      const repairs: CarryArgRepair[] = [];
      const out = coerceWallRowShape({ kind: 'approval' }, 'walls[0]', repairs);
      expect(out).toEqual({ kind: 'approval' });
      expect(repairs).toHaveLength(0);
    });

    it('reports the rename it DID make, so the repair is observable rather than silent', () => {
      const repairs: CarryArgRepair[] = [];
      coerceWallRowShape({ description: 'owner call' }, 'walls[0]', repairs);
      expect(repairs.map((r) => r.field)).toContain('walls[0].description');
    });

    it('keeps a canonical claim when both claim and an alias are supplied', () => {
      const repairs: CarryArgRepair[] = [];
      const out = coerceWallRowShape({ claim: 'canonical', description: 'alias' }, 'walls[0]', repairs);
      expect((out as { claim: string }).claim).toBe('canonical');
    });

    it('passes non-object rows straight through', () => {
      const repairs: CarryArgRepair[] = [];
      expect(coerceWallRowShape('a compact claim', 'walls[0]', repairs)).toBe('a compact claim');
      expect(coerceWallRowShape(null, 'walls[0]', repairs)).toBe(null);
      expect(repairs).toHaveLength(0);
    });
  });
});
