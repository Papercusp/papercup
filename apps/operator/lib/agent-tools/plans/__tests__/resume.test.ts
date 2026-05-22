/**
 * Unit coverage for the pure derivation in `plans:resume`
 * (plan-agent-launch-2026-05-21, P-013).
 *
 * `derivePlanChangeWarning` is pure. The handler itself is heavy IO
 * (run lookup, context bundle, agent spawn) — exercised live in
 * P-027 / P-028.
 */

import { describe, expect, it } from 'vitest';
import { derivePlanChangeWarning } from '../resume';

describe('derivePlanChangeWarning', () => {
  it('returns null when the run hash matches the current plan hash', () => {
    expect(derivePlanChangeWarning('abc123', 'abc123', 'my-plan')).toBeNull();
  });

  it('warns when the plan changed since the run was last active', () => {
    const warning = derivePlanChangeWarning('old-hash', 'new-hash', 'my-plan');
    expect(warning).not.toBeNull();
    expect(warning).toContain('my-plan');
    expect(warning).toContain('changed');
    expect(warning).toContain('current version');
  });

  it('treats any hash difference as stale — empty vs non-empty', () => {
    expect(derivePlanChangeWarning('', 'h', 'p')).not.toBeNull();
    expect(derivePlanChangeWarning('h', '', 'p')).not.toBeNull();
  });

  it('names the specific plan slug in the warning', () => {
    const warning = derivePlanChangeWarning('a', 'b', 'plan-agent-launch-2026-05-21');
    expect(warning).toContain('plan-agent-launch-2026-05-21');
  });
});
