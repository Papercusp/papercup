import { describe, it, expect } from 'vitest';
import { verifyPlanClaims, formatPlanClaimViolations } from './plan-claim-guard';

/** A fileExists backed by a fixed set of "present" paths. */
const existsIn = (present: string[]) => (p: string) => present.includes(p);

describe('verifyPlanClaims (EI-479 vaporware guard core)', () => {
  it('TEETH: the exact EI-479 case — a shipped claim naming a MISSING file is a violation', () => {
    const text = `## P-042 — PR poll daemon
- P-042: \`apps/operator/lib/pr-host/poll-daemon.ts\` — 60s poll. ✅ DONE; 6 tests.`;
    const r = verifyPlanClaims(text, existsIn([])); // the file never existed
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].path).toBe('apps/operator/lib/pr-host/poll-daemon.ts');
    expect(r.violations[0].line).toBe(2);
  });

  it('a shipped claim naming a PRESENT file is fine', () => {
    const text = `- P-001: \`packages/operator-core/lib/pr-host/poll-daemon.ts\` ✅ DONE.`;
    const r = verifyPlanClaims(text, existsIn(['packages/operator-core/lib/pr-host/poll-daemon.ts']));
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(1);
  });

  it('a CORRECTION line citing a gone path is NOT a violation (it documents the vaporware)', () => {
    const text = [
      '> CORRECTION (EI-479): the P-042 line was FALSE —',
      '> `apps/operator/lib/pr-host/poll-daemon.ts` was marked DONE but **never existed**.',
    ].join('\n');
    const r = verifyPlanClaims(text, existsIn([]));
    expect(r.ok).toBe(true); // "was FALSE"/"never existed" ⇒ correction, skipped
  });

  it('a struck (~~…~~) shipped line is treated as a correction, not a live claim', () => {
    const text = '- ~~P-042: `apps/x/gone.ts` ✅ DONE~~ **FALSE — never built**';
    expect(verifyPlanClaims(text, existsIn([])).ok).toBe(true);
  });

  it('a path on a NON-shipped line is not checked (only shipped/done claims gate)', () => {
    const text = '- P-050: planned — will live at `packages/operator-core/lib/future.ts` (TODO).';
    const r = verifyPlanClaims(text, existsIn([]));
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(0);
  });

  it('ignores non-anchored / wrong-extension / un-backticked paths (false-positive guard)', () => {
    const text = [
      '- ✅ DONE: see foo/bar.ts (no backticks)',
      '- ✅ DONE: `README.md` (not root-anchored)',
      '- ✅ DONE: `packages/x/thing.py` (unsupported ext)',
    ].join('\n');
    const r = verifyPlanClaims(text, existsIn([]));
    expect(r.checked).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('checks multiple claims per shipped line + reports each missing one', () => {
    const text =
      '- ✅ shipped: `packages/a/here.ts` + `packages/b/gone.ts` (two files)';
    const r = verifyPlanClaims(text, existsIn(['packages/a/here.ts']));
    expect(r.checked).toBe(2);
    expect(r.violations.map((v) => v.path)).toEqual(['packages/b/gone.ts']);
  });

  it('ignores ELLIPSIS-abbreviated paths (`.../`) — plan shorthand, not a literal claim (real-corpus false-positive)', () => {
    const text = '- **P-014** `done` `libs/agent-chat/.../useHarnessChatRuntime.test.tsx` — hook test SHIPPED';
    const r = verifyPlanClaims(text, existsIn([]));
    expect(r.checked).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('formatPlanClaimViolations renders ok + violation summaries', () => {
    const ok = verifyPlanClaims('- ✅ DONE `packages/a/x.ts`', existsIn(['packages/a/x.ts']));
    expect(formatPlanClaimViolations('plan-x', ok)).toContain('verified ✓');
    const bad = verifyPlanClaims('- ✅ DONE `packages/a/missing.ts`', existsIn([]));
    const msg = formatPlanClaimViolations('plan-x', bad);
    expect(msg).toContain('vaporware claim');
    expect(msg).toContain('packages/a/missing.ts');
  });
});
