/**
 * Recurrence guard for WI-10002186, extended for P-007.
 *
 * The hybrid capture contract must survive the actual SU prompt assembler, not
 * merely exist in an un-rendered source file. This pins the live blueprint
 * `su.md` path and asks renderSuPlaybook for the same deterministic composition
 * used by a new interactive session.
 *
 * P-007 (clause AUTO-BAR-R-10-P-007@2) requires the instruction to reach BOTH
 * the engineer and the power su role. `playbookCandidates` falls back to the
 * engineer overlay when a profile-specific one is missing, so asserting the
 * directive text alone would pass vacuously for `power` even if that profile
 * stopped rendering its own playbook. Each case therefore also pins the
 * profile's OWN overlay header — that is what makes this two real cases rather
 * than the same case run twice.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSuPlaybook } from './desktop-install/papercusp-files';

const REPO_ROOT = join(fileURLToPath(new URL('../../../', import.meta.url)));
const DEFAULT_BLUEPRINT_SU = join(
  REPO_ROOT,
  'libs',
  'papercusp',
  'packages',
  'harness',
  'blueprints',
  'base',
  'prompts',
  'su.md',
);
/**
 * Overridable so a mutation probe can point the subject at a COPY outside the
 * shared checkout (CLAUDE.md "proving a guard is falsifiable", tier 2) instead
 * of mutating a tracked file that git-sync would sweep into a commit.
 */
const BLUEPRINT_SU = process.env.PAPERCUSP_SU_BASE_SOURCE ?? DEFAULT_BLUEPRINT_SU;
const OPERATOR_PROMPTS = join(REPO_ROOT, 'apps', 'operator', 'prompts');

/**
 * A heading that exists in exactly ONE overlay — the anti-vacuity control.
 * Derived by diffing the two overlays' H2 sets, not guessed: the overlay H1 is
 * not carried into the render, so it cannot serve as the discriminator.
 */
const PROFILE_OVERLAY_MARKER: Record<'engineer' | 'power', string> = {
  engineer: '## Orientation: what Papercusp is',
  power: "## Orientation: the nouns you'll navigate",
};

const SU_PROFILES = ['engineer', 'power'] as const;

describe('rendered SU persona — hybrid owner-directive capture (WI-10002186, P-007)', () => {
  it.each(SU_PROFILES)(
    'keeps capture and next-turn resolution instructions in the live %s render',
    async (profile) => {
      const rendered = await renderSuPlaybook({
        agent: 'claude',
        profile,
        baseSource: BLUEPRINT_SU,
        overlayDir: OPERATOR_PROMPTS,
        projectGuideSource: '',
        renderWireSchemas: () => '',
      });

      expect(rendered.baseSource).toBe(BLUEPRINT_SU);

      // Anti-vacuity: this profile really rendered ITS OWN overlay, not the
      // engineer fallback. Without this, `power` would be a duplicate case.
      expect(rendered.text).toContain(PROFILE_OVERLAY_MARKER[profile]);

      expect(rendered.text).toContain('## Owner directives — durable capture and resolution');
      expect(rendered.text).toContain(
        'UserPromptSubmit hook records the owner turn verbatim as a PENDING row',
      );
      expect(rendered.text).toContain("orders:resolve-pending { id, action: 'promote' }");
      expect(rendered.text).toContain("orders:resolve-pending { id, action: 'dismiss', reason }");
      expect(rendered.text).toContain("orders:disposition { id, status: 'done'|'declined', note }");
    },
  );
});
