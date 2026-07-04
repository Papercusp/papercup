/**
 * EI-7275 — check-vite-externalized-warnings.mjs gate logic:
 *   - counts "Module X has been externalized for browser compatibility" warnings
 *     from a raw vite build output,
 *   - ratchet-only-down (a below-baseline run lowers the baseline only on
 *     --update, mirroring lint-tsc.mjs's EI-104 policy).
 *
 * The script's pure functions are imported directly (same pattern as
 * lint-tsc.test.ts).
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import { countExternalizedWarnings, decide } from '../../../scripts/check-vite-externalized-warnings.mjs';

const SAMPLE = [
  '(!) [plugin rolldown:vite-resolve] Module "node:fs" has been externalized for browser compatibility, imported by "/repo/lib/log-events.ts". See https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.',
  '(!) [plugin rolldown:vite-resolve] Module "node:path" has been externalized for browser compatibility, imported by "/repo/lib/join-shared-harness.ts". See https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.',
  'some unrelated build log line',
  "(!) Module 'tls' has been externalized for browser compatibility, imported by \"/repo/node_modules/pg/lib/stream.js\".",
].join('\n');

describe('countExternalizedWarnings', () => {
  it('counts each externalized-module warning line, ignoring unrelated lines', () => {
    expect(countExternalizedWarnings(SAMPLE)).toBe(3);
  });

  it('returns 0 for clean output', () => {
    expect(countExternalizedWarnings('')).toBe(0);
    expect(countExternalizedWarnings('build succeeded, no warnings\n')).toBe(0);
  });

  it('matches both single- and double-quoted module names', () => {
    expect(
      countExternalizedWarnings(
        `Module "node:fs" has been externalized for browser compatibility\nModule 'node:path' has been externalized for browser compatibility`,
      ),
    ).toBe(2);
  });
});

describe('decide — --update-only ratchet (mirrors lint-tsc.mjs EI-104 policy)', () => {
  it('above baseline fails (bare or --update)', () => {
    expect(decide({ warningCount: 628, baselineCount: 627 }).verdict).toBe('fail-exceeds');
    expect(decide({ warningCount: 628, baselineCount: 627, updateFlag: true }).verdict).toBe('fail-exceeds');
  });

  // The core ratchet guard: a BARE run below baseline must NOT lock in — only a
  // deliberate --update lowers it, so a transient dip (e.g. an optional dep not
  // installed) can't silently shrink the baseline and false-red a later run.
  it('below baseline on a BARE run is check-only — no ratchet, no newBaseline', () => {
    const r = decide({ warningCount: 600, baselineCount: 627 });
    expect(r).toEqual({ verdict: 'ok-below', belowBy: 27 });
    expect(r.newBaseline).toBeUndefined();
  });

  it('below baseline WITH --update ratchets the baseline down', () => {
    const r = decide({ warningCount: 600, baselineCount: 627, updateFlag: true });
    expect(r).toEqual({ verdict: 'ok-ratchet', newBaseline: 600 });
  });

  it('at baseline is ok and never raises (bare or --update)', () => {
    expect(decide({ warningCount: 627, baselineCount: 627 }).verdict).toBe('ok');
    expect(decide({ warningCount: 627, baselineCount: 627, updateFlag: true }).verdict).toBe('ok');
  });
});
