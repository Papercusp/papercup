import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROFILER_ENV_GATE,
  judgeProfilerSafetyPosture,
  stripComments,
} from './loop-profiler-safety-posture';

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR = join(HERE, '../event-loop-lag-monitor.ts');

/** The live tree's shape, reduced to the three lines the doc claim actually rests on. */
const SAFE = [
  "const envProfileGate =",
  `  process.env.${PROFILER_ENV_GATE} === '1' || process.env.${PROFILER_ENV_GATE} === 'true';`,
  'const fixed = opts.profileOnSaturation ?? envProfileGate;',
  'const profileMaxP95Ms = opts.profileMaxP95Ms ?? 3000;',
].join('\n');

describe('loop-profiler safety posture doc claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('accepts the live shape', () => {
      const v = judgeProfilerSafetyPosture({ monitorSource: SAFE });
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.maxP95DefaultMs).toBe(3000);
    });

    it('catches the cap being deleted', () => {
      const v = judgeProfilerSafetyPosture({
        monitorSource: SAFE.replace('const profileMaxP95Ms = opts.profileMaxP95Ms ?? 3000;', ''),
      });
      expect(v.ok).toBe(false);
      expect(v.maxP95DefaultMs).toBeNull();
      expect(v.problems.join(' ')).toContain('profileMaxP95Ms');
    });

    it('catches the gate inverted to default-ON via !==', () => {
      const v = judgeProfilerSafetyPosture({
        monitorSource: SAFE.replace(
          `process.env.${PROFILER_ENV_GATE} === '1'`,
          `process.env.${PROFILER_ENV_GATE} !== '0'`,
        ),
      });
      expect(v.ok).toBe(false);
      expect(v.envGateStrictOptIn).toBe(false);
      expect(v.problems.join(' ')).toContain('default-ON');
    });

    it('catches the production gate defaulting to literal true', () => {
      const v = judgeProfilerSafetyPosture({
        monitorSource: SAFE.replace('?? envProfileGate', '?? true'),
      });
      expect(v.ok).toBe(false);
      expect(v.optsGateDefaultsToEnv).toBe(false);
    });

    it('does NOT accept a mention inside a comment as a live wiring', () => {
      // This is the control that matters most for THIS file: every real claim site in the
      // monitor sits beside JSDoc that names these identifiers repeatedly, so a judge that
      // did not strip comments would keep reporting "safe" long after the code was deleted.
      const commentedOnly = [
        '/**',
        ` * We gate on ${PROFILER_ENV_GATE} and cap with opts.profileMaxP95Ms ?? 3000.`,
        ' */',
        '// const fixed = opts.profileOnSaturation ?? envProfileGate;',
        'const profileMaxP95Ms = ALWAYS_PROFILE;',
      ].join('\n');
      const v = judgeProfilerSafetyPosture({ monitorSource: commentedOnly });
      expect(v.ok).toBe(false);
      expect(v.maxP95DefaultMs).toBeNull();
    });

    it('treats an Infinity cap as no cap', () => {
      const v = judgeProfilerSafetyPosture({
        monitorSource: SAFE.replace('?? 3000', '?? Number.POSITIVE_INFINITY'),
      });
      expect(v.ok).toBe(false);
      expect(v.maxP95DefaultMs).toBeNull();
    });
  });

  describe('stripComments', () => {
    it('drops block comments but keeps the code around them', () => {
      expect(stripComments('const a = 1; /* note\n more */ const b = 2;')).toContain('const b = 2;');
      expect(stripComments('/* PAPERCUSP_LOOP_PROFILER */')).not.toContain('PAPERCUSP');
    });

    it('drops a trailing line comment but keeps the code before it', () => {
      expect(stripComments('const a = 1; // note')).toContain('const a = 1;');
    });
  });

  describe('the live tree', () => {
    it('keeps the in-process CPU profiler default-OFF and finitely capped', () => {
      const monitorSource = readFileSync(MONITOR, 'utf8');
      const v = judgeProfilerSafetyPosture({ monitorSource });

      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.envGateStrictOptIn).toBe(true);
      expect(v.optsGateDefaultsToEnv).toBe(true);

      // Positive control on the INSTRUMENT, not the subject: an unreadable or empty file
      // would ALSO produce "no problems" for the checks above if they were written as mere
      // absence tests, so assert the judge actually resolved a real finite cap.
      expect(v.maxP95DefaultMs).toBeGreaterThan(0);
      expect(Number.isFinite(v.maxP95DefaultMs)).toBe(true);
      expect(monitorSource).toContain('captureCpuProfile');
    });
  });
});
