import { describe, expect, it } from 'vitest';

import {
  CAPTURED_RESULT_MARKER_PLACEHOLDER,
  GREEN_CHECKPOINT_RESULT_MARKER,
  ORCHESTRATOR_STDOUT_TAG,
  ORCHESTRATOR_STDOUT_TAG_UNDER_TEST,
  defangCapturedResultMarkers,
  orchestratorStdoutTag,
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

  // EI-19346606967082413 extended what goes into this body: the orchestrator transcript is
  // now prepended to the suite output. That transcript is TEED from the same log() the gate
  // narrates itself with, so a line in it can carry a result marker too — which would walk
  // straight back into the impostor-verdict hole this whole describe exists to close.
  //
  // The write site composes defang(transcript + suiteOutput) as ONE string for exactly this
  // reason. A refactor that prepends the transcript OUTSIDE the defang call — the natural
  // way to write it, and it looks harmless — would reopen the hole for the half of the body
  // a reader is most likely to trust, because the transcript is the gate's own voice rather
  // than captured fixture noise. This is the negative control for that.
  it('defangs a marker that arrives via the ORCHESTRATOR transcript, not just the suite output', () => {
    const transcript =
      '--- orchestrator transcript (1 line(s)) ---\n' +
      `2026-08-02T16:00:00.000Z [green-checkpoint] ${GREEN_CHECKPOINT_RESULT_MARKER} {"reason":"up-to-date","green":true}\n` +
      '--- end orchestrator transcript ---\n';
    const suiteOutput = ' Test Files  571 passed (573)\n';

    // Composed the way the write site composes it: ONE defang pass over both halves.
    const persisted = defangCapturedResultMarkers(transcript + suiteOutput);

    expect(persisted).not.toContain(GREEN_CHECKPOINT_RESULT_MARKER);
    expect(persisted).toContain(CAPTURED_RESULT_MARKER_PLACEHOLDER);
    // the fence and the suite output are untouched — defanging neutralises the marker only
    expect(persisted).toContain('--- orchestrator transcript (1 line(s)) ---');
    expect(persisted).toContain('--- end orchestrator transcript ---');
    expect(persisted).toContain(' Test Files  571 passed (573)');
  });
});

/**
 * WI-7274 — the SECOND instance of the class the describe above closed for one token.
 *
 * The gate's own suite drives real `runGreen` (green-checkpoint-real-deps.test.ts), so it emits
 * real narration lines, and the suite's stdout is captured verbatim into the persisted log.
 * Vitest's `stdout | <file>` provenance header sits on a SEPARATE line, so no line-oriented
 * grep ever returns it.
 *
 * Measured on ~/.papercusp/checkpoint-logs/2026-08-03T01-36-17-607Z-...-cand-060ea000f206.log:
 *   grep "holding the gate" -> 4 hits, ALL FOUR fixtures (lines 8444/8457/8482/8492).
 * The run's actual verdict was in the tail, in a different shape entirely.
 */
describe('WI-7274: orchestrator narration cannot impersonate a verdict', () => {
  // ---- the guard that matters MOST: a real run must stay exactly as it was ---------------
  // If this inverts, every genuine verdict line is labelled a fixture and the production
  // candidate parser (release-checkpoint-launch.ts) stops recognising real runs. That is a
  // far worse failure than the bug being fixed, so it is asserted first and from both sides.

  it('⭐ a REAL run narrates under the unchanged production tag', () => {
    expect(orchestratorStdoutTag({} as NodeJS.ProcessEnv)).toBe(ORCHESTRATOR_STDOUT_TAG);
    expect(ORCHESTRATOR_STDOUT_TAG).toBe('[green-checkpoint]');
  });

  it('the vars the gate DOES set for its children never trip the fixture branch', () => {
    // buildGreenCheckpointEnv sets these; none of them may imply "under test", or the gate
    // would mark its own verdict a fixture. (Verified on live orchestrator pid 1490611.)
    const gateEnv = {
      VITEST_MAX_FORKS: '8',
      VITEST_MAX_THREADS: '8',
      VITEST_UNIT_TIMEOUT_MS: '180000',
    } as unknown as NodeJS.ProcessEnv;
    expect(orchestratorStdoutTag(gateEnv)).toBe(ORCHESTRATOR_STDOUT_TAG);
  });

  it('a process under a test runner narrates under the fixture tag', () => {
    expect(orchestratorStdoutTag({ VITEST: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(
      ORCHESTRATOR_STDOUT_TAG_UNDER_TEST,
    );
    expect(orchestratorStdoutTag({ NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv)).toBe(
      ORCHESTRATOR_STDOUT_TAG_UNDER_TEST,
    );
  });

  // ---- the property that repairs every EXISTING reader, with no change on their side ------

  it('⭐ the fixture tag does not contain the production tag, so `grep "[green-checkpoint]"` drops fixtures', () => {
    expect(ORCHESTRATOR_STDOUT_TAG_UNDER_TEST).not.toContain(ORCHESTRATOR_STDOUT_TAG);
    // and it is still recognisable to a human scanning the log
    expect(ORCHESTRATOR_STDOUT_TAG_UNDER_TEST).toContain('green-checkpoint');
  });

  it('separates the measured 4 fixture hits from a real verdict line', () => {
    // Verbatim shapes from the 060ea000f206 log (colour codes stripped).
    const fixture = `${ORCHESTRATOR_STDOUT_TAG_UNDER_TEST} suite red was absorbed as a load-flake, but a post-suite leg FAILED — holding the gate: lint:tsc`;
    const real = `${ORCHESTRATOR_STDOUT_TAG} suite red was absorbed as a load-flake, but a post-suite leg FAILED — holding the gate: lint:tsc`;
    const body = [
      'stdout | lib/release/green-checkpoint-real-deps.test.ts > realCheckpointDeps.runGreen',
      fixture,
      ' Test Files  571 passed (573)',
      real,
    ].join('\n');

    const hits = body.split('\n').filter((l) => l.includes('holding the gate'));
    expect(hits).toHaveLength(2); // the grep still finds both — that is fine
    // ...but they are now telling apart, which is the whole fix:
    expect(hits.filter((l) => l.startsWith(`${ORCHESTRATOR_STDOUT_TAG} `))).toEqual([real]);
    expect(hits.filter((l) => l.includes(ORCHESTRATOR_STDOUT_TAG_UNDER_TEST))).toEqual([fixture]);
  });

  // ---- STATED LIMIT, pinned so it cannot read as covered ---------------------------------
  // D-003: a fix's SCOPE is a premise too. This tags the LINE; a reader that throws the line
  // away is untouched. Asserting the gap keeps "leg 1 landed" from being mistaken for "the
  // class is closed", and the day someone closes it this test fails and points at the reason.

  it('⚠ KNOWN LIMIT: the prefix-blind candidate parser still harvests a sha from a tagged fixture', () => {
    const taggedFixture = `${ORCHESTRATOR_STDOUT_TAG_UNDER_TEST} checkpointing candidate deadbeef (base cafe1234)`;
    // release-checkpoint-launch.ts:343, verbatim — no anchor of any kind.
    const parseCandidates = (text: string) =>
      [...text.matchAll(/checkpointing candidate (\S+)/g)].map((m) => m[1]);

    // The missed case really IS bad: a fixture sha is returned as if it were this run's.
    expect(parseCandidates(taggedFixture)).toEqual(['deadbeef']);

    // And it CANNOT be fixed by anchoring positively on the production tag, because the
    // persisted log's orchestrator transcript carries the same line UNPREFIXED — measured at
    // line 3 of the 060ea000f206 log. Anchoring would break real candidate extraction.
    const realTranscriptLine = '2026-08-03T01:15:05.333Z checkpointing candidate 060ea000 (base 1e0ddc58)';
    expect(realTranscriptLine).not.toContain(ORCHESTRATOR_STDOUT_TAG);
    expect(parseCandidates(realTranscriptLine)).toEqual(['060ea000']);
  });
});
