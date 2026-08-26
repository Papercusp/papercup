/**
 * P-005 / D-006 — current guidance may describe the retired tier historically,
 * but may not prescribe it as an executor. The live-tree assertion makes this an
 * enforcing test, while the fixtures prove both error directions are discriminating.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — untyped .mjs guard helper, imported for its pure detector.
import {
  ACTIVE_RETIRED_GUIDANCE_FILES,
  ACTIVE_RETIRED_GUIDANCE_ROOTS,
  collectActiveRetiredGuidance,
  findRetiredGuidanceOffenders,
} from '../../../scripts/lib/retired-tier-guidance.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('retired-tier current-guidance detector', () => {
  it('flags the measured obsolete template mechanism', () => {
    const source = [
      '# Agent work plane',
      '',
      'The -ops hive is the Queen surveying a backlog and placing member harnesses.',
      'Use Queen/bee dispatch to assign the next unit and wake a Mug supervisor.',
    ].join('\n');
    const findings = findRetiredGuidanceOffenders('templates/example/GUIDE.md', source);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: 'current-guidance', line: 3, roles: ['queen', 'mug'] });
  });

  it('allows explicit historical, retirement, and refusal accounts', () => {
    const source = [
      'Historical note: the Queen once surveyed the backlog and placed bees.',
      '',
      'The Mug-supervised nursery tier is RETIRED permanently; cup:spawn now refuses.',
      '',
      'Never wake the Kettle or dispatch work to the Mug; use canonical plan promotion instead.',
    ].join('\n');
    expect(findRetiredGuidanceOffenders('history.md', source)).toEqual([]);
  });

  it('does not let a historical preface hide a renewed prescription after an adversative', () => {
    const source = 'The Mug was retired, but use the Mug to dispatch ready work and wake the Kettle.';
    expect(findRetiredGuidanceOffenders('bad.md', source)).toEqual([
      expect.objectContaining({ line: 1, roles: ['mug', 'kettle'] }),
    ]);
  });

  it('ignores homonyms without an execution prescription', () => {
    expect(findRetiredGuidanceOffenders('kitchen.md', 'Choose the current kettle and mug size.')).toEqual([]);
  });

  it('beats the naive token-only rule on explicitly historical text', () => {
    const historical = 'The Queen once placed bees; this executor is retired and was replaced.';
    const naiveTokenOnly =
      /\b(?:queen|mug|kettle)\b/i.test(historical) && /\b(?:place|dispatch|wake)/i.test(historical);
    expect(naiveTokenOnly).toBe(true);
    expect(findRetiredGuidanceOffenders('history.md', historical)).toEqual([]);
  });
});

describe('retired-tier current-guidance live verdict', () => {
  it('scans every canonical active root and the canonical su prompt with zero exemptions-by-baseline', () => {
    const result = collectActiveRetiredGuidance(REPO_ROOT);
    expect(result.missingPaths).toEqual([]);
    expect(result.readErrors).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(ACTIVE_RETIRED_GUIDANCE_FILES.length);
    expect(result.offenders).toEqual([]);

    const scanned = new Set(
      [...ACTIVE_RETIRED_GUIDANCE_ROOTS, ...ACTIVE_RETIRED_GUIDANCE_FILES].map((entry) =>
        entry.split(path.sep).join('/'),
      ),
    );
    expect(scanned).toEqual(
      new Set([
        'templates/papercusp-app',
        'templates/papercusp-ops-pots',
        'libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
      ]),
    );
  });
});
