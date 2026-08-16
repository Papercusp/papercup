/**
 * `locks:acquire_granular`'s description must stay true about what it EXCLUDES
 * (EI-20471899135452182; sibling of `gate-candidate-ref.test.ts`, same P-004 family).
 *
 * The FIXTURE controls are load-bearing for the reason the siblings state: once the live
 * assertion goes green it stops being evidence that the detector works at all. The first
 * fixture reproduces the EXACT text that shipped until 2026-08-16 — the sentence the
 * WI-39007 release lane read as "I hold an exclusive snapshot of the tree".
 *
 * Run: cd packages/operator-core && npx vitest run lib/doc-claims/granular-lock-cross-domain.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeGranularCrossDomain, stripComments } from './granular-lock-cross-domain';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GRANULAR_STORE = join(ROOT, 'libs/papercusp/packages/locks/src/granular-lock-store.ts');

/** Pad a fixture past the min-length refusal so we test the RULE, not the guard. */
const pad = (body: string): string => `${body}\n${'// filler\n'.repeat(80)}`;

/** A store body that reads ONLY its own domain — today's measured reality. */
const SPLIT_STORE = pad(`
  const held = await tx\`SELECT node FROM agent_granular_locks WHERE node = ANY(\${nodes})\`;
`);
/** A store body that ALSO consults the classic domain — the bridge, once it lands. */
const BRIDGED_STORE = pad(`
  const held = await tx\`SELECT node FROM agent_granular_locks WHERE node = ANY(\${nodes})\`;
  const files = await tx\`SELECT path FROM agent_file_locks WHERE path = ANY(\${nodes})\`;
`);

/** The sentence that actually shipped, and cost WI-39007 its snapshot. */
const FALSE_DESCRIPTION =
  'The lock places the matching intention on every ancestor incl. the harness root, so a ' +
  'harness-exclusive (X on "") now conflicts with any descendant file lock.';
/** The corrected sentence: true intra-domain claim + the explicit boundary. */
const CORRECTED_DESCRIPTION =
  'so a harness-exclusive (X on "") conflicts with any descendant GRANULAR lock. ' +
  'It does NOT exclude classic file locks (locks:acquire, and every automatic per-edit ' +
  'hook claim) — a separate domain the granular conflict check never reads.';

describe('locks:acquire_granular cross-domain claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the exact false promise that shipped — the WI-39007 belief', () => {
      const verdict = judgeGranularCrossDomain({
        storeSource: SPLIT_STORE,
        description: FALSE_DESCRIPTION,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.bridged).toBe(false);
      expect(verdict.promisesCrossDomain).toBe(true);
      expect(verdict.violations.join('\n')).toMatch(/not an exclusive snapshot/);
    });

    it('catches the warning silently rotting away (split domains, boundary dropped)', () => {
      const verdict = judgeGranularCrossDomain({
        storeSource: SPLIT_STORE,
        description: 'Acquire a multi-granularity intention lock on a path NODE. All-or-nothing.',
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.disclaimsCrossDomain).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/Restore the boundary/);
    });

    it('catches a landed BRIDGE whose description still disclaims — forces the doc update', () => {
      const verdict = judgeGranularCrossDomain({
        storeSource: BRIDGED_STORE,
        description: CORRECTED_DESCRIPTION,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.bridged).toBe(true);
      expect(verdict.violations.join('\n')).toMatch(/bridge landed — update this text/);
    });

    it('passes the corrected pairing — so the controls above are not passing vacuously', () => {
      const verdict = judgeGranularCrossDomain({
        storeSource: SPLIT_STORE,
        description: CORRECTED_DESCRIPTION,
      });
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('does not mistake the TRUE intra-domain claim for the false cross-domain one', () => {
      // "conflicts with any descendant GRANULAR lock" is correct and must not trip the rule.
      const verdict = judgeGranularCrossDomain({
        storeSource: SPLIT_STORE,
        description: CORRECTED_DESCRIPTION,
      });
      expect(verdict.promisesCrossDomain).toBe(false);
    });
  });

  describe('false-absence refusals (an unread subject must not read as a clean pass)', () => {
    it('refuses a too-short store source', () => {
      expect(() =>
        judgeGranularCrossDomain({ storeSource: 'const x = 1;', description: CORRECTED_DESCRIPTION }),
      ).toThrow(/Refusing to judge/);
    });

    it('refuses an empty description', () => {
      expect(() =>
        judgeGranularCrossDomain({ storeSource: SPLIT_STORE, description: '   ' }),
      ).toThrow(/empty description/);
    });

    it('refuses a source whose positive control is empty (wrong file)', () => {
      expect(() =>
        judgeGranularCrossDomain({
          storeSource: pad('const held = await tx`SELECT 1`;'),
          description: CORRECTED_DESCRIPTION,
        }),
      ).toThrow(/positive control found 0 mentions/);
    });
  });

  describe('comment stripping', () => {
    it('does not count a prose mention of the classic table as code', () => {
      const verdict = judgeGranularCrossDomain({
        // The real store's scope-bound comments name the other domain; that is not a bridge.
        storeSource: pad(`
          // this domain never reads agent_file_locks
          /* nor does it read agent_file_locks here */
          const held = await tx\`SELECT node FROM agent_granular_locks\`;
        `),
        description: CORRECTED_DESCRIPTION,
      });
      expect(verdict.bridged).toBe(false);
      expect(verdict.ok).toBe(true);
    });

    it('stripComments blanks line and block comments', () => {
      expect(stripComments('a // x\nb').join('\n')).toBe('a \nb');
      expect(stripComments('/* y */c').join('\n')).toBe('       c');
    });
  });

  describe('the live subject', () => {
    it('the shipped description agrees with the shipped granular store', async () => {
      const storeSource = readFileSync(GRANULAR_STORE, 'utf8');
      const tool = (await import('../agent-tools/locks/acquire_granular')).default;

      const verdict = judgeGranularCrossDomain({
        storeSource,
        description: tool.description,
      });

      // Fails if the trap returns, if the boundary is dropped, or — the day the lock
      // authority bridges the domains — if this description is not updated with it.
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
      // Positive control: we really did read the granular store.
      expect(verdict.ownDomainSites.length).toBeGreaterThan(0);
    });
  });
});
