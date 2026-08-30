import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCheckpointCandidates } from '@papercusp/operator-core/lib/release-checkpoint-launch';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- untyped shared .mjs helper, reached the same way green-checkpoint.ts reaches
// scripts/lib/vitest-summary.mjs. Deliberately NOT re-implemented here: a copy-pasted
// comment stripper is the phantom-offender root cause (EI-19991116787260658).
import { stripCommentsOnly } from '../../../../scripts/lib/strip-comments-and-strings.mjs';
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

  it('the candidate parser EXCLUDES a tagged fixture line and keeps BOTH real shapes', () => {
    // EI-19395755190419540 — this was pinned here as a ⚠ KNOWN LIMIT: WI-7274 tagged the LINE
    // but `parseCheckpointCandidates` had no anchor at all, so it still harvested `deadbeef`
    // out of a line the emitter had already marked as a fixture. That corrupted the AUTOMATED
    // answer to "which sha is the gate judging?" — the one CLAUDE.md sends every agent to.
    //
    // This now imports the REAL parser instead of restating its regex. The pinned version
    // carried a verbatim COPY of the implementation, which is exactly why it could describe
    // the limit precisely and still never notice if the real parser changed underneath it.
    // A guard that re-implements its subject cannot detect drift in that subject.
    // ⚠ THIS ASSERTION ALSO GUARDS A HAND-SYNCED LITERAL, deliberately. It builds its fixture
    // line from green-checkpoint.ts's `ORCHESTRATOR_STDOUT_TAG_UNDER_TEST` and filters it with
    // the operator-core leaf's copy (via the real parser). While the two definitions are
    // separate — they are being deduped under EI-19395755190419540, the leaf is the single
    // source and green-checkpoint.ts re-exports it — any divergence between them fails HERE,
    // loudly, instead of silently un-filtering fixtures in production. Keep it built this way
    // round even after the dedupe: it costs nothing and it is the only place the two ends of
    // that import meet.
    const taggedFixture = `${ORCHESTRATOR_STDOUT_TAG_UNDER_TEST} checkpointing candidate deadbeef (base cafe1234)`;
    expect(parseCheckpointCandidates(taggedFixture)).toEqual([]);

    // ⚠ The exclusion must stay NEGATIVE. It CANNOT be done by anchoring positively on the
    // production tag, because the persisted log's orchestrator transcript carries the same
    // line UNPREFIXED — measured at line 3 of the 060ea000f206 log. A positive anchor would
    // silently zero extraction for the scheduler-fired runs that are the majority, and a zero
    // reads as "no candidate found", not as "my regex is wrong". This assertion is what fails
    // if someone later "simplifies" it that way.
    const realTranscriptLine = '2026-08-03T01:15:05.333Z checkpointing candidate 060ea000 (base 1e0ddc58)';
    expect(realTranscriptLine).not.toContain(ORCHESTRATOR_STDOUT_TAG);
    expect(parseCheckpointCandidates(realTranscriptLine)).toEqual(['060ea000']);

    // The prefixed /tmp-manual shape keeps matching too — two real shapes, one parser.
    const realStdoutLine = `${ORCHESTRATOR_STDOUT_TAG} checkpointing candidate 13d9c65d (base 1e0ddc58)`;
    expect(parseCheckpointCandidates(realStdoutLine)).toEqual(['13d9c65d']);

    // And the shape the gate actually persists: fixture interleaved with real. Only the real
    // candidates come back, in emission order — which is what the LAST-match reader
    // (EI-19327704778173646) depends on being true.
    const mixedLog = [realTranscriptLine, taggedFixture, realStdoutLine].join('\n');
    expect(parseCheckpointCandidates(mixedLog)).toEqual(['060ea000', '13d9c65d']);
  });
});

/**
 * EI-20203883939710354 — the THIRD leg of this class, and the one the first two leave open.
 *
 * WI-7274 (above) tagged the fixture LINE; EI-19395755190419540 taught the candidate parser to
 * exclude it. Both fix a reader who has already noticed the tag. Neither helps the reader whose
 * FIRST move is `grep <my-workspace> <the shared run log>` — because `green-checkpoint-real-deps`
 * drives real `runGreen`, production narrates real lines, and vitest captures them verbatim.
 *
 * Measured on that suite's own stdout BEFORE this guard: 316 fixture-tagged narration lines, of
 * which 23 named a REAL `@papercusp/*` workspace, in 11 distinct shapes — including
 *   "...post-suite leg FAILED — holding the gate: @papercusp/operator-vite (SPA build)"
 * which is a perfect description of an actionable failure that never happened. An agent triaging
 * a fleet-blocking gate red hit exactly that line and nearly filed it as the root cause; the tag
 * was present and still cost the wrong diagnosis, because a tag is only read AFTER the line has
 * already been believed.
 *
 * So this guard removes the COLLISION rather than adding another marker to parse: fixtures name
 * fake workspaces, and a grep for a real one cannot return them at all.
 *
 * ⚠ SCOPE, stated so it cannot read as covered (D-003): this guards the SIMULATED SUBPROCESS
 * OUTPUT — the `>>> <ws> :: npm run test` headers production parses a workspace name out of and
 * re-narrates. It deliberately does NOT forbid every `@papercusp/*` literal in that file: the
 * `r.failingTests` assertions must keep naming `@papercusp/operator-vite`, because there it is
 * the release-fixer's DEDUP SENTINEL (checkpointFailureSignature hardcodes it, and its stability
 * is what makes a build break dedup by failure rather than by candidate sha) — not a workspace
 * reference. Those never reach a narration line, so they cannot collide with a grep.
 */
describe('EI-20203883939710354: real-deps fixtures cannot collide with a real-workspace grep', () => {
  const source: string = stripCommentsOnly(
    readFileSync(
      fileURLToPath(new URL('./green-checkpoint-real-deps.test.ts', import.meta.url)),
      'utf8',
    ),
    'green-checkpoint-real-deps.test.ts',
  );

  it('⭐ every simulated `>>> <workspace> :: npm run test` header names a FAKE workspace', () => {
    const workspaces = [...source.matchAll(/>>> (\S+) :: npm run test/g)].map((m) => m[1]);

    // POSITIVE CONTROL. Without it a reformat that breaks this regex yields an empty list, and
    // "no real workspaces found" would pass for the one reason that means the guard is blind.
    expect(workspaces.length).toBeGreaterThan(0);
    expect(workspaces.filter((w) => w.startsWith('@papercusp/'))).toEqual([]);
  });

  it('pins the SPA build workspace to a fake one, so the SPA narration cannot name the real SPA', () => {
    // Left unset, releaseConfig defaults this to the real `@papercusp/operator-vite` and the
    // "holding the gate: <ws> (SPA build)" narration names it — the exact reported line.
    expect(source).toMatch(/spaBuildWorkspace:\s*['"]@example\//);
  });
});
