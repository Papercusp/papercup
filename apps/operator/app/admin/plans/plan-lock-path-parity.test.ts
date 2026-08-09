/**
 * The plan-lock banner's client/server path contract (P-025 of
 * semantic-search-fingerprint-coverage-2026-08-03).
 *
 * WHAT BREAKS WITHOUT THIS
 * ------------------------
 * The banner's liveness spans two workspaces that agree only by convention:
 *
 *   • CLIENT — `planLockPath(slug, archived)` builds the string `usePlanLock`
 *     subscribes with, off its own local `PLANS_DIR_REL` copy.
 *   • SERVER — `isPlanLockPath()` decides which lock transitions are allowed to
 *     EMIT at all, off `agent-tools/plans/source`'s `PLANS_DIR_REL`.
 *
 * They are two separate string literals in two packages. If they ever drift,
 * the client subscribes to `planLock.byPath` with a path the server's filter
 * rejects — so no invalidation is ever emitted for it and the banner silently
 * stops updating. Nothing throws, no test fails, and the panel keeps rendering
 * a holder that may have released minutes ago.
 *
 * That failure mode is NEW as of P-025 and is why this guard exists. Under the
 * old 30s poll a drifted constant broke the read outright — visible, because
 * the banner then showed nothing at all. Push turns the same drift into a
 * stale-but-plausible banner, which is the harder bug to notice and the more
 * dangerous one, since the banner exists to stop two shells editing one plan.
 *
 * Asserting the PROPERTY (a client-built path survives the server's filter)
 * rather than comparing the two constants is deliberate: the filter also tests
 * the `.md` suffix and normalises separators, so a constant-equality check
 * would pass while a real path was still rejected.
 */
import { describe, expect, it } from 'vitest';
import { isPlanLockPath } from '@papercusp/operator-core/lib/agent-tools/locks/notify-lock-change';
import { planLockPath } from './plans-api';

describe('plan-lock path parity (client builder ↔ server emit filter)', () => {
  it('a live plan path the client subscribes with is emitted by the server', () => {
    const p = planLockPath('semantic-search-fingerprint-coverage-2026-08-03', false);
    expect(p).toBe(
      'apps/operator/docs/plans/semantic-search-fingerprint-coverage-2026-08-03.md',
    );
    expect(isPlanLockPath(p)).toBe(true);
  });

  it('an ARCHIVED plan path is emitted too', () => {
    // The archive lives one level deeper, so a filter written as an exact
    // directory match rather than a prefix would pass the test above and drop
    // every archived plan's invalidations.
    const p = planLockPath('some-old-plan', true);
    expect(p).toBe('apps/operator/docs/plans/archive/some-old-plan.md');
    expect(isPlanLockPath(p)).toBe(true);
  });

  it('CONTROL: the filter is selective — a non-plan path is not emitted', () => {
    // Without this, a filter that returned true unconditionally would satisfy
    // both assertions above. It also pins the scoping decision recorded in
    // notify-lock-change.ts: the file-lock guard runs on EVERY agent file edit
    // fleet-wide, so widening this filter re-creates a WI-840 fan-out storm.
    expect(isPlanLockPath('packages/operator-core/lib/sync-resolver/index.ts')).toBe(false);
    expect(isPlanLockPath('apps/operator/docs/plans/not-markdown.txt')).toBe(false);
    expect(isPlanLockPath('docs/plans/wrong-root.md')).toBe(false);
  });
});
