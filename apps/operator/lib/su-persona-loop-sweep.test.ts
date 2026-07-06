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

/** The su/interactive persona sources swept in B-LOOP-FIN-1. */
const SU_PERSONAS = [
  'hive-instances/papercup-hive.su.md', // the live instance override (SU_BLUEPRINT_PERSONA path)
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
      expect(lc, 'D-007: excludes the autonomous mug/cup/blender loop').toContain('mug/cup/blender');
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
