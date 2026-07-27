import { describe, expect, it } from 'vitest';

import {
  CAPTURED_RESULT_MARKER_PLACEHOLDER,
  GREEN_CHECKPOINT_RESULT_MARKER,
  defangCapturedResultMarkers,
} from './green-checkpoint';

/**
 * EI-18832272104497819 — the persisted suite log (~/.papercusp/checkpoint-logs/*.log) is
 * NOT the verdict channel. The real verdict is printed to the CLI's own stdout after that
 * file is written, so every marker occurring inside captured suite output is a fixture
 * emitted by release-actions.test.ts (which drives the routine with fake stdout that the
 * routine then echoes).
 *
 * Measured on four consecutive real logs on 2026-07-27: 9 markers each, ALL fixtures, the
 * run's own verdict absent entirely. Both natural greps return an impostor:
 *   first (`grep -m1`) -> {"reason":"up-to-date","green":true}   <- reads as a false GREEN
 *   last  (`| tail -1`) -> candidate "deadbeefcafe0123", failing "lib/y.test.ts"
 * The first-marker case is the dangerous one and the original report missed it: a false
 * GREEN is how an agent concludes the gate cleared and stops working.
 */
describe('EI-18832272104497819: captured fixture markers cannot impersonate a verdict', () => {
  // Verbatim from ~/.papercusp/checkpoint-logs/2026-07-27T21-05-23-161Z-...-cand-42123c7841cd.log
  const capturedSuiteOutput = [
    'stdout | release-actions.test.ts > green-checkpoint scope isolation',
    `[green-checkpoint] ${GREEN_CHECKPOINT_RESULT_MARKER} {"reason":"up-to-date","green":true}`,
    ' Test Files  571 passed (573)',
    `[green-checkpoint] ${GREEN_CHECKPOINT_RESULT_MARKER} {"reason":"not-green","green":false,"candidate":"abc123"}`,
    `[green-checkpoint] ${GREEN_CHECKPOINT_RESULT_MARKER} {"reason":"not-green","green":false,"candidate":"deadbeefcafe0123","failingTests":["lib/y.test.ts"],"recorded":true}`,
  ].join('\n');

  it('⭐ leaves NO raw marker for either grep direction to find', () => {
    const persisted = defangCapturedResultMarkers(capturedSuiteOutput);
    expect(persisted).not.toContain(GREEN_CHECKPOINT_RESULT_MARKER);
    // The decisive one: the FIRST-marker read can no longer yield a false GREEN.
    const firstMarkerLine = persisted.split('\n').find((l) => l.includes('"green":true'));
    expect(firstMarkerLine).toBeDefined();
    expect(firstMarkerLine).not.toContain(GREEN_CHECKPOINT_RESULT_MARKER);
  });

  it('replaces each marker with a token that is self-explaining, not merely deleted', () => {
    const persisted = defangCapturedResultMarkers(capturedSuiteOutput);
    // A reader who greps the log must still SEE that these lines were fixtures, rather
    // than find the payloads floating with no provenance (which reads as corruption).
    expect(persisted.split(CAPTURED_RESULT_MARKER_PLACEHOLDER)).toHaveLength(4); // 3 markers
  });

  // ---- negative controls: the fix must not defang more than the marker ----------------
  // A too-greedy fix (line-eating regex / stripping any "green" JSON) would pass the
  // assertions above while destroying the diagnostic value the log exists for.

  it('preserves every other byte of the suite output verbatim', () => {
    const persisted = defangCapturedResultMarkers(capturedSuiteOutput);
    expect(persisted).toContain(' Test Files  571 passed (573)');
    expect(persisted).toContain('stdout | release-actions.test.ts > green-checkpoint scope isolation');
    // the fixture PAYLOADS survive — only the marker token they hid behind is neutralised
    expect(persisted).toContain('{"reason":"not-green","green":false,"candidate":"abc123"}');
    expect(persisted).toContain('"failingTests":["lib/y.test.ts"]');
    expect(persisted.split('\n')).toHaveLength(capturedSuiteOutput.split('\n').length);
  });

  it('is a no-op on output that never mentioned the marker', () => {
    const clean = ' Test Files  3490 passed | 7 skipped (3497)\n      Tests  42576 passed\n';
    expect(defangCapturedResultMarkers(clean)).toBe(clean);
  });

  it('the placeholder is not itself the marker (a self-defeating substitution)', () => {
    expect(CAPTURED_RESULT_MARKER_PLACEHOLDER).not.toContain(GREEN_CHECKPOINT_RESULT_MARKER);
  });
});
