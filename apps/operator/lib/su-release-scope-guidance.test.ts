/**
 * EI-20223212233187962 — the release checkpoint is a workspace-global gate.
 *
 * The generic SU scope guidance says to add `harness` to most project-facing
 * calls. Keep the explicit exception in every Papercusp SU source that can
 * reach an operator session, so the live schema is not obscured by that rule.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const SOURCES = [
  'papercusp-su-engineer.tools.md',
  'pot-instances/papercup-pot.su.md',
];

describe('SU release checkpoint scope guidance (EI-20223212233187962)', () => {
  for (const source of SOURCES) {
    it(`${source} identifies release:checkpoint-run as workspace-global`, () => {
      const prompt = readFileSync(join(PROMPTS, source), 'utf8');

      expect(prompt).toMatch(
        /`release:checkpoint-run` is workspace-global, not\s+harness-scoped\./,
      );
      expect(prompt).toMatch(
        /live schema accepts only `force`, `replaceStale`, `paths`,\s+`waitForEligibility`, and `reason`/,
      );
      expect(prompt).toContain('do **not** pass `harness` to it');
    });

    it(`${source} identifies release:trace as workspace-global`, () => {
      const prompt = readFileSync(join(PROMPTS, source), 'utf8');

      expect(prompt).toMatch(
        /`release:trace` is also workspace-global, not\s+harness-scoped\./,
      );
      expect(prompt).toMatch(
        /`release:trace` is also workspace-global[\s\S]*?live schema\s+accepts only `path`, `sha`, `work_item`, and `after_generation`/,
      );
      expect(prompt).toContain('`harness` in its JSON arguments');
    });
  }
});
