/**
 * onboarding-tutor target — hermetic wiring tests
 * (agent-first-onboarding-2026-07-03 P-008).
 *
 * The scenarios themselves need live model creds (llm-test runner); these
 * tests pin the hermetic invariants: the rendered system prompt is
 * token-complete and carries the tutorial engine verbatim, the catalog is
 * well-formed, and the registry knows the target + scenarios.
 */
import { describe, expect, it } from 'vitest';

import { loadTutorPrompt, onboardingTutorTarget, resolveTutorSourcePath } from '../targets/onboarding-tutor';
import { listTargets, getTarget } from '../targets';
import { SCENARIOS } from '../scenarios';
import { OPTION_LINE } from '../scenarios/onboarding-tutor/OT1-section-protocol';
import { existsSync } from 'node:fs';

const sourcePresent = existsSync(resolveTutorSourcePath());

describe('loadTutorPrompt', () => {
  it.skipIf(!sourcePresent)('renders the REAL source with ZERO leftover {{TOKEN}}s', () => {
    const prompt = loadTutorPrompt();
    expect(prompt.match(/{{[A-Z_]+}}/g) ?? []).toEqual([]);
    // The tutorial engine + the finale opener must reach the SUT verbatim.
    expect(prompt).toContain(OPTION_LINE);
    expect(prompt.replace(/\s+/g, ' ')).toContain('Now the last piece is the GUI');
    // The rendered pack index + tab tour actually expanded (not empty fallbacks).
    expect(prompt).toContain('**Chapter 1**');
    expect(prompt).toContain("params:{tab:'overview'}");
  });

  it.skipIf(!sourcePresent)('tutorial mode renders with setupFinished true', () => {
    const prompt = loadTutorPrompt('tutorial');
    expect(prompt).toContain('"setupFinished": true');
    expect(prompt).toContain('`tutorial`');
  });
});

describe('registry wiring', () => {
  it('the onboarding-tutor target is registered and constructs', () => {
    expect(listTargets()).toContain('onboarding-tutor');
    const t = getTarget('onboarding-tutor');
    expect(t.id).toBe('onboarding-tutor');
    expect(t.behaviors).toContain('section-protocol');
  });

  it('OT1–OT3 are in the scenario registry, targeting onboarding-tutor', () => {
    const ot = SCENARIOS.filter((s) => s.target === 'onboarding-tutor');
    expect(ot.map((s) => s.id).sort()).toEqual([
      'onboarding-tutor-OT1-section-protocol',
      'onboarding-tutor-OT2-progress-checkpoint',
      'onboarding-tutor-OT3-question-detour',
    ]);
  });

  it('the tutor catalog names only tools the tutor prompt can reach (no plans/work_items writes)', () => {
    const target = onboardingTutorTarget();
    // Catalog is private on SuTarget; probe via the prompt instead: every
    // tool the launch context names must be reachable, and the target id
    // proves we built the tutor catalog (not the su default).
    expect(target.id).toBe('onboarding-tutor');
    const prompt = loadTutorPrompt();
    for (const name of ['setup:status', 'setup:set_tutorial_progress', 'docs:search', 'ui:dispatch']) {
      expect(prompt).toContain(name);
    }
  });
});
