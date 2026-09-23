/**
 * Guards the B-LOOP-5 / B-LOOP-FIN-1 prompt sweep: the su/interactive persona
 * sources must steer recurrence onto the ENGINE loop (loop:arm) and away from the
 * client's native /loop, while the AUTONOMOUS mug/cup/blender prompts stay excluded
 * (plan loop-routines-interval-recurrence-2026-06-20, D-007). A content test rather
 * than an assembly test — it guards the source files the sweep edited from regressing
 * (e.g. a future persona rewrite silently dropping the rule).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const read = (rel: string) => readFileSync(join(PROMPTS, rel), 'utf8');
const BLUEPRINT_SU = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'libs',
  'papercusp',
  'packages',
  'harness',
  'blueprints',
  'base',
  'prompts',
  'su.md',
);

/** The su/interactive persona sources swept in B-LOOP-FIN-1. */
const SU_PERSONAS = [
  'pot-instances/papercup-pot.su.md', // the live instance override (SU_BLUEPRINT_PERSONA path)
  'papercusp-su-engineer.tools.md', // the legacy engineer playbook
  'papercusp-su-power.tools.md', // the legacy power playbook
  'papercusp-su.claude.md', // the Claude client overlay (where /loop natively lives)
];

describe('su/interactive personas steer recurrence onto the engine loop (B-LOOP-FIN-1)', () => {
  for (const rel of SU_PERSONAS) {
    it(`${rel} carries the engine-loop rule (loop:arm + the do-not-/loop steer + the D-007 scope)`, () => {
      const md = read(rel);
      const lc = md.toLowerCase();
      // Declares the verb the agent uses to recur.
      expect(md, 'declares loop:arm as the recurrence verb').toContain('loop:arm');
      // Steers off the client-native self-pacing...
      expect(lc, 'steers off client-native self-pacing').toMatch(/self-pace/);
      // ...naming /loop as the thing being replaced.
      expect(md, 'names /loop as the replaced mechanism').toContain('/loop');
      // D-007: scopes the rule to su/interactive, NOT the autonomous loop.
      // Anchored to the PROPERTY (this persona DISCLAIMS the autonomous loop), never to one
      // spelling of it. This used to assert the literal 'mug/cup/blender'; the mug/cup/kettle
      // tier is now retired behind `papercusp-mug-kettle-system`
      // (retire-mug-kettle-su-only-2026-08-09, D-029) and Blender is the half that survives,
      // so the personas no longer share that wording — but the EXCLUSION must still be stated.
      // Falsifiable: deleting the disclaimer, or flipping it to a claim, fails this.
      const flat = lc.replace(/\s+/g, ' ');
      expect(flat, 'D-007: disclaims the autonomous loop').toMatch(
        /not\**\s+the\s+autonomous[^.]{0,80}\bloop\b/,
      );
    });
  }

  // D-007 pot-rename: bee.md was an orphaned prompt and is deleted; the autonomous worker
  // role is now `cup`, and its "native /loop disabled" rule lives in the harness blueprints
  // (libs/papercusp/.../blueprints/**/prompts), not apps/operator/prompts. Skipped here —
  // the exclusion is guarded at the blueprint layer now, not against a file in this dir.
  it.skip('autonomous-role loop:arm exclusion moved to harness blueprints (bee.md removed)', () => {
    // bee.md keeps its own "native /loop is disabled" rule; it must NOT gain the
    // su/interactive self-loop verb — the sweep deliberately excludes the autonomous loop.
    expect(read('bee.md')).not.toContain('loop:arm');
  });
});

describe('canonical SU persona — owner-directive capture (WI-10002186)', () => {
  it('keeps the every-turn-is-open capture and resolution contract on the live blueprint path', () => {
    const persona = readFileSync(BLUEPRINT_SU, 'utf8');
    const sectionStart = persona.indexOf('## Owner directives — durable capture and resolution');
    const autoMode = persona.indexOf('<!-- PAPERCUSP-SU:AUTO-MODE -->');

    expect(sectionStart, 'the owner-directive section must remain in the canonical persona').toBeGreaterThanOrEqual(0);
    expect(autoMode, 'the generated AUTO seam must remain present').toBeGreaterThan(sectionStart);

    const section = persona.slice(sectionStart, autoMode);
    // D-001 of owner-directive-delivery-redesign-2026-09-22: every turn lands
    // open and ends only by disposition; the promote/dismiss triage is gone.
    expect(section).toContain('records the turn verbatim as an OPEN row, and there is no triage step');
    expect(section).toContain("orders:disposition { id, status: 'done'|'declined', note }");
    expect(section).toContain('orders:summarize { id, summary }');
    expect(section).not.toContain('orders:resolve-pending');
  });
});
