/**
 * extractAssertions — VAL-* inline assertion parsing.
 *
 * P-064 of harness-tests-tab-and-tester-promotion-2026-05-26: the
 * `RequiresTest:` sub-bullet (default true; explicit false exempts a VAL
 * from the tester/validator test gate) round-trips through the parser.
 */

import { describe, expect, it } from 'vitest';
import { extractAssertions } from '../val-assertions';

const PLAN = [
  '- **P-001** `todo` Implement CSV export.',
  '  - **[VAL-demo-001]**',
  '    - **Verify:** `GET /x` returns 200',
  '    - **Evidence:** `tests/x.test.ts`',
  '    - **Status:** `todo`',
  '  - **[VAL-demo-002]**',
  '    - **Verify:** The button copy reads "Download".',
  '    - **Evidence:** Visual — design-spec match.',
  '    - **Status:** `todo`',
  '    - **RequiresTest:** `false`',
  '  - **[VAL-demo-003]**',
  '    - **Verify:** Header row matches column order.',
  '    - **Evidence:** `tests/x.test.ts`',
  '    - **Status:** `passed`',
  '    - **RequiresTest:** `true`',
].join('\n');

describe('extractAssertions — RequiresTest', () => {
  const byId = Object.fromEntries(extractAssertions(PLAN).map((a) => [a.valId, a]));

  it('parses all three assertions with Verify/Evidence/Status intact', () => {
    expect(Object.keys(byId).sort()).toEqual(['VAL-demo-001', 'VAL-demo-002', 'VAL-demo-003']);
    expect(byId['VAL-demo-001'].verifyText).toBe('`GET /x` returns 200');
    expect(byId['VAL-demo-003'].status).toBe('passed');
  });

  it('defaults requiresTest to true when the sub-bullet is absent', () => {
    expect(byId['VAL-demo-001'].requiresTest).toBe(true);
  });

  it('parses an explicit `RequiresTest: false` as an exemption', () => {
    expect(byId['VAL-demo-002'].requiresTest).toBe(false);
  });

  it('parses an explicit `RequiresTest: true`', () => {
    expect(byId['VAL-demo-003'].requiresTest).toBe(true);
  });
});
