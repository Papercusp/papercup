/**
 * Pins the `directed-implementer` persona's tool claims to the real deny list (P-004).
 *
 * The FIXTURE CONTROLS are load-bearing for the reason the siblings state: once the live
 * assertion goes green it stops being evidence that the detector works at all. Each fixture
 * reproduces a drift that MUST be caught — including the exact one that motivated this pin
 * (a persona reasoning from a denial that has since been removed).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIRECTED_IMPLEMENTER_DENY_TOOLS,
  directedImplementerConfinement,
  evaluateSessionConfinement,
} from '../capability-envelope/session-confinement';
import {
  extractToolTokens,
  judgePersonaToolClaims,
} from './directed-implementer-persona-tool-claims';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PERSONA = join(
  ROOT,
  'libs/papercusp/packages/harness/blueprints/base/prompts/directed-implementer.md',
);

/** The real gate, bound to the real launch confinement — never a reimplemented matcher. */
const confinement = directedImplementerConfinement({
  directorSid: 'su-fixture-director',
  scope: 'fixture-plan',
});
const isDenied = (tool: string): boolean =>
  !evaluateSessionConfinement({ toolName: tool, confinement }).allowed;

/**
 * Tokens the persona presents AS denied rather than as instructions to call. Adding a
 * token here is a deliberate act: it asserts the deny list really refuses it.
 */
const DENIED_MENTIONS = ['loop:arm'] as const;

describe('directed-implementer persona tool claims', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches a persona reasoning from a denial that is no longer on the list', () => {
      const verdict = judgePersonaToolClaims({
        personaMd: 'Nothing re-invokes you: `loop:arm` is denied to you by design.',
        deniedMentions: ['loop:arm'],
        isDenied: () => false, // the entry was removed
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.unbackedDenialClaims).toEqual(['loop:arm']);
      expect(verdict.violations.join('\n')).toMatch(/no longer|does not refuse it/);
    });

    it('catches an instruction to call a tool that is denied', () => {
      const verdict = judgePersonaToolClaims({
        personaMd: 'Settle it with `coord:thread { root_msg_id: <id> }` before re-executing.',
        deniedMentions: [],
        isDenied: (t) => t === 'coord:thread', // someone denied the recovery path
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.unusableInstructions).toEqual(['coord:thread']);
      expect(verdict.violations.join('\n')).toMatch(/would hit a refusal/);
    });
  });

  describe('token extraction (prose must not read as a tool call)', () => {
    it('reads tool names out of backticked spans, including inside an args object', () => {
      const tokens = extractToolTokens(
        'Use `coord:feed { from: <id>, kinds: [\'message\'] }` and `work_items:complete`.',
      );
      expect(tokens).toEqual(['coord:feed', 'work_items:complete']);
    });

    it('does not mistake provenance tags or object keys for tool names', () => {
      // Every one of these appears in the live persona.
      const tokens = extractToolTokens(
        'Tag it `[peer:<director-sid> · director for WI-NNN]`, never `[owner:…]`. ' +
          'Send with `expects: \'answer\'`. Not `[self-imposed]`, not `[inferred]`.',
      );
      expect(tokens).toEqual([]);
    });
  });

  describe('the live persona', () => {
    const personaMd = readFileSync(PERSONA, 'utf8');

    it('names only denials the deny list actually enforces, and calls only allowed tools', () => {
      const verdict = judgePersonaToolClaims({
        personaMd,
        deniedMentions: DENIED_MENTIONS,
        isDenied,
      });
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('still carries the D-004 minimum set it claims is enforced at the server', () => {
      // The persona's "what you cannot do" section states these three in prose.
      for (const verb of ['work_items:complete', 'loop:arm', 'scheduler:get_next']) {
        expect(DIRECTED_IMPLEMENTER_DENY_TOOLS).toContain(verb);
        expect(isDenied(verb)).toBe(true);
      }
    });

    it('states the compaction-recovery contract P-004 requires', () => {
      // The clause with no coverage before P-004: an implementer that compacts mid-milestone.
      expect(personaMd).toMatch(/## If you compact mid-milestone/);
      // Its three load-bearing moves.
      expect(personaMd).toMatch(/have I already replied/i);
      expect(personaMd).toMatch(/no wake source of your own/i);
      expect(personaMd).toMatch(/verbatim/i);
    });
  });
});
