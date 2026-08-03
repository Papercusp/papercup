/**
 * affected-tests-failing-files-line.test.ts — EI-19395701908500754 regression guard.
 *
 * ## What broke
 *
 * `AFFECTED_TESTS_RESULT ... failed=N` counts TASKS (workspaces). Nothing in a
 * green-checkpoint verdict log named the failing FILES, so triagers mined prose for them —
 * and the prose they reached for was the gate's own `[green-checkpoint] isolation:
 * re-running <files>` narration. green-checkpoint's self-tests drive the real `runGreen`,
 * so those lines are emitted by FIXTURES too and land interleaved in the persisted log.
 *
 * Measured on the 01:36:17Z red (`...-cand-060ea000f206.log`): mining `isolation:` yielded
 * `lib/a.test.ts` / `lib/b.test.ts` — files that do not exist in this tree — while the real
 * break set was 11 files spanning BOTH failing workspaces. Two agents reached opposite
 * conclusions from the same log inside ten minutes.
 *
 * WI-7274 tagged the fixture lines so they are identifiable. This is the other half: give
 * the run a first-class per-FILE break set so there is no reason to read the prose at all.
 *
 * ## What these tests pin
 *
 * 1. The coverage taxonomy — specifically that an EMPTY file list can never read as
 *    "nothing failed" while failed tasks exist. That is the failure mode this whole shape
 *    exists to prevent, and it is the one a naive `files=[]` would reintroduce.
 * 2. The line is single-line and machine-parseable (a log reader greps ONE line).
 * 3. The adversarial property: the fixture prose that misled the original reader cannot
 *    contribute a single path to the new break set.
 * 4. The runner actually wires it in — a formatter nothing calls is not a fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatFailingFilesLine,
  renderFailingFilesSummary,
  parseFailedTestFiles,
  AFFECTED_TESTS_FAILING_FILES_TOKEN,
  FAILING_FILES_LINE_MAX_ENTRIES,
} from '../../../../scripts/lib/vitest-summary.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

/** Parse the emitted line back into fields, the way a log consumer would. */
function parseLine(line: string) {
  const scalar = (k: string) => line.match(new RegExp(`\\b${k}=([^\\s]+)`))?.[1];
  const json = (k: string) => {
    const at = line.indexOf(`${k}=[`);
    if (at < 0) return null;
    const from = line.slice(at + k.length + 1);
    // The two JSON payloads are adjacent; take the first balanced array.
    let depth = 0;
    for (let i = 0; i < from.length; i++) {
      if (from[i] === '[') depth++;
      else if (from[i] === ']' && --depth === 0) return JSON.parse(from.slice(0, i + 1));
    }
    return null;
  };
  return {
    run: scalar('run'),
    coverage: scalar('coverage'),
    fileCount: Number(scalar('fileCount')),
    unattributedCount: Number(scalar('unattributedCount')),
    truncated: scalar('truncated') === 'true',
    files: json('files') as Array<{ workspace: string; file: string }> | null,
    unattributed: json('unattributed') as Array<{ task: string; reason: string }> | null,
  };
}

describe('formatFailingFilesLine — coverage is reported separately from scope', () => {
  it('reports coverage=complete only when every failed task was attributed to files', () => {
    const line = formatFailingFilesLine({
      runToken: '1234-abcd0000',
      entries: [
        { workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' },
        { workspace: '@papercusp/web', file: 'app/_lints/no-nul-bytes.test.ts' },
      ],
    });
    const p = parseLine(line);
    expect(p.coverage).toBe('complete');
    expect(p.fileCount).toBe(2);
    expect(p.unattributedCount).toBe(0);
    expect(p.files).toEqual([
      { workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' },
      { workspace: '@papercusp/web', file: 'app/_lints/no-nul-bytes.test.ts' },
    ]);
  });

  /**
   * THE case this shape exists for. A run where tasks failed but none could be attributed
   * must not emit anything a reader can mistake for a clean result. Under a bare
   * `files=[...]` field this run and a green one are byte-identical on the file list.
   */
  it('never reads as clean when tasks failed but no file could be named', () => {
    const line = formatFailingFilesLine({
      runToken: '1234-abcd0000',
      entries: [],
      unattributed: [{ task: '@papercusp/operator-core :: test', reason: 'no-file-rows' }],
    });
    const p = parseLine(line);
    expect(p.coverage).toBe('unattributed');
    expect(p.fileCount).toBe(0);
    // The distinguishing evidence: the failure is stated, with its reason, not omitted.
    expect(p.unattributedCount).toBe(1);
    expect(p.unattributed).toEqual([{ task: '@papercusp/operator-core :: test', reason: 'no-file-rows' }]);
    // And it is NOT the same line a genuinely-empty run would produce.
    expect(line).not.toBe(formatFailingFilesLine({ runToken: '1234-abcd0000' }));
  });

  it('reports coverage=partial when only some failed tasks were attributed', () => {
    const p = parseLine(
      formatFailingFilesLine({
        runToken: '1234-abcd0000',
        entries: [{ workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' }],
        unattributed: [{ task: 'papercusp-desktop :: cargo test', reason: 'non-vitest' }],
      }),
    );
    expect(p.coverage).toBe('partial');
    expect(p.fileCount).toBe(1);
    expect(p.unattributedCount).toBe(1);
  });

  it('reports coverage=none only when nothing failed at all', () => {
    expect(parseLine(formatFailingFilesLine({ runToken: 't' })).coverage).toBe('none');
  });

  it('carries the run token so a fixture line cannot be mistaken for this run', () => {
    // The token is the same one in `Full run log: /tmp/papercusp-affected-tests-<token>.log`,
    // which is what lets a reader tie a break set to a specific run in an interleaved log.
    expect(parseLine(formatFailingFilesLine({ runToken: '99-deadbeef' })).run).toBe('99-deadbeef');
  });

  it('stays on ONE line even with paths that would otherwise break a log reader', () => {
    const line = formatFailingFilesLine({
      runToken: 't',
      entries: [{ workspace: '@papercusp/web', file: 'lib/weird\nname.test.ts' }],
    });
    expect(line.split('\n')).toHaveLength(1);
    expect(parseLine(line).files).toEqual([{ workspace: '@papercusp/web', file: 'lib/weird\nname.test.ts' }]);
  });

  it('truncates a pathological break set but keeps the COUNT exact', () => {
    const entries = Array.from({ length: FAILING_FILES_LINE_MAX_ENTRIES + 5 }, (_, i) => ({
      workspace: '@papercusp/operator-core',
      file: `lib/f${i}.test.ts`,
    }));
    const p = parseLine(formatFailingFilesLine({ runToken: 't', entries }));
    expect(p.truncated).toBe(true);
    expect(p.fileCount).toBe(entries.length); // the count is never truncated
    expect(p.files).toHaveLength(FAILING_FILES_LINE_MAX_ENTRIES);
  });
});

describe('the fixture prose that caused EI-19395701908500754 cannot reach the break set', () => {
  /**
   * VERBATIM from the red-#12 verdict log
   * (`2026-08-03T01-36-17-607Z-base-1e0ddc586454-cand-060ea000f206.log`). Every path here
   * is SYNTHETIC — `lib/a.test.ts`, `lib/b.test.ts` do not exist in this tree — and the
   * candidate `abc123` is a fixture sha. This is what a `grep 'isolation:'` returned.
   */
  const FIXTURE_CONTAMINATED_LOG = [
    '[green-checkpoint] isolation: re-running 2 originally-failing file(s) at single concurrency: lib/a.test.ts, lib/b.test.ts',
    '[green-checkpoint] isolation: ALL 2 originally-failing file(s) PASSED ... absorbed as load-flake(s): @papercusp/operator-core::lib/a.test.ts, @papercusp/operator-core::lib/b.test.ts',
    '[green-checkpoint] __CAPTURED_TEST_FIXTURE_RESULT__ {"reason":"not-green","green":false,"candidate":"abc123"}',
    '[green-checkpoint] worker-crash: ALL 1 crashed workspace(s) PASSED on a reduced-concurrency re-run — absorbed as load/infra flake(s): @papercusp/operator-core',
    '[green-checkpoint] suite red was absorbed as a load-flake, but a post-suite leg FAILED — holding the gate: @papercusp/operator-vite (SPA build)',
  ].join('\n');

  it('yields ZERO files from the prose an agent actually mined', () => {
    // The prose names five plausible-looking paths. The break set is derived from vitest's
    // own line-anchored FAIL/rollup rows, which narration cannot forge.
    expect(FIXTURE_CONTAMINATED_LOG).toContain('lib/a.test.ts');
    expect(parseFailedTestFiles(FIXTURE_CONTAMINATED_LOG)).toEqual([]);
  });

  it('still names the REAL failures when genuine vitest rows are interleaved with that prose', () => {
    // The falsifier for the test above: prove it returns [] because the prose is not a FAIL
    // row, NOT because the parser is inert on this input.
    const withRealRows = [
      FIXTURE_CONTAMINATED_LOG,
      ' ❯ lib/release/green-checkpoint-real-deps.test.ts (12 tests | 2 failed) 812ms',
      'FAIL  app/adv/create/PreviewPanel.test.tsx',
    ].join('\n');
    expect(parseFailedTestFiles(withRealRows).sort()).toEqual([
      'app/adv/create/PreviewPanel.test.tsx',
      'lib/release/green-checkpoint-real-deps.test.ts',
    ]);
  });
});

describe('scripts/affected-tests.mjs wires the line in (a formatter nothing calls is not a fix)', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8');

  it('emits the canonical line on the failure path', () => {
    expect(source).toContain('formatFailingFilesLine');
    const failureBlock = source.slice(source.indexOf('if (failed) {'));
    expect(failureBlock).toContain('formatFailingFilesLine({ runToken: RUN_TOKEN');
    // Emitted alongside — not instead of — the task-level verdict line.
    expect(failureBlock).toContain("resultLine('failed')");
  });

  it('records a failed task that cannot be attributed, rather than dropping it', () => {
    // Dropping it is what makes an empty list read as clean; each reason must be reachable.
    for (const reason of ['no-captured-output', 'no-file-rows', 'non-vitest']) {
      expect(source).toContain(`reason: '${reason}'`);
    }
  });

  it('stamps the same run token that names the full run log', () => {
    expect(source).toContain('const RUN_LOG_PATH = `/tmp/papercusp-affected-tests-${RUN_TOKEN}.log`');
  });

  it('greps for the token via the shared constant, so a rename cannot desync', () => {
    expect(AFFECTED_TESTS_FAILING_FILES_TOKEN).toBe('AFFECTED_TESTS_FAILING_FILES');
  });
});
