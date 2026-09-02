import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ATTRIBUTION_ENV_NAME,
  judgeAttributionArming,
  stripLineComments,
} from './attribution-arming';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = join(REPO_ROOT, 'scripts/affected-tests.mjs');

describe('attribution-arming doc claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the exact pre-P-006 tree: a child env with no arming', () => {
      const before = [
        'const childEnv = {',
        '  ...process.env,',
        '  VITEST_MAX_WORKERS: String(allocation.workers),',
        '};',
      ].join('\n');
      const v = judgeAttributionArming({ affectedTestsSource: before });
      expect(v.ok).toBe(false);
      expect(v.affectedTestsArmedAt).toEqual([]);
      expect(v.problems.join(' ')).toContain(ATTRIBUTION_ENV_NAME);
    });

    it('accepts the object-literal arming form used in the child env', () => {
      const v = judgeAttributionArming({
        affectedTestsSource: `const childEnv = {\n  ${ATTRIBUTION_ENV_NAME}: "1",\n};`,
      });
      expect(v.ok).toBe(true);
      expect(v.affectedTestsArmedAt).toEqual([2]);
    });

    it('accepts the property-assignment form and single quotes', () => {
      const v = judgeAttributionArming({
        affectedTestsSource: `env.${ATTRIBUTION_ENV_NAME} = '1';`,
      });
      expect(v.ok).toBe(true);
    });

    it('does NOT accept a mention inside a comment as a wiring', () => {
      // The failure this control exists for is concrete, not hypothetical: every real arming
      // site in this repo sits under a long comment that names the variable several times, so
      // a scan that did not strip comments would pass on a block whose assignment was deleted.
      const commentedOnly = [
        `// P-006: we arm ${ATTRIBUTION_ENV_NAME}: "1" here so the gate attributes coverage.`,
        `// (was: ${ATTRIBUTION_ENV_NAME} = '1')`,
        'const childEnv = { ...process.env };',
      ].join('\n');
      const v = judgeAttributionArming({ affectedTestsSource: commentedOnly });
      expect(v.ok).toBe(false);
    });

    it('does NOT accept arming to a value other than 1', () => {
      // A `'0'` reads as "the variable is wired" to any grep for the NAME, which is the shape
      // that would let a deliberate disarm masquerade as a live wiring.
      const v = judgeAttributionArming({
        affectedTestsSource: `const childEnv = { ${ATTRIBUTION_ENV_NAME}: "0" };`,
      });
      expect(v.ok).toBe(false);
    });
  });

  describe('stripLineComments', () => {
    it('drops a trailing comment but keeps the code before it', () => {
      expect(stripLineComments('const a = 1; // note').join('')).toContain('const a = 1;');
    });

    it('drops a full-line comment entirely', () => {
      expect(stripLineComments('  // just prose').join('').trim()).toBe('');
    });
  });

  describe('the live tree', () => {
    it('keeps coverage attribution armed in the affected-tests child env', () => {
      const v = judgeAttributionArming({
        affectedTestsSource: readFileSync(AFFECTED_TESTS, 'utf8'),
      });
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
      // Positive control on the INSTRUMENT, not the subject: if the file were unreadable or
      // empty the judge would also report "not armed", so assert it actually saw a real file.
      expect(v.affectedTestsArmedAt.length).toBeGreaterThan(0);
    });
  });
});
