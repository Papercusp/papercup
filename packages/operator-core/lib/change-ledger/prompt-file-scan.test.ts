/**
 * prompt-file-scan.test.ts — the pure git-log parser + the injected-deps scan
 * pass (self-learning-frontier P-004 / FB-02). The real git invocation lives
 * in harness/routines/change-ledger-scan-action.ts; the ledger write side is
 * change-ledger.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { RecordBehaviorChangeInput } from './change-ledger';
import {
  parsePromptEditLog,
  PROMPT_SCAN_GIT_ARGS,
  PROMPT_SOURCE_PATHS,
  scanRepoPromptEdits,
} from './prompt-file-scan';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b1c2d3e4f5a6b7c8d9e0a1b2c3d4e5f6a7b8c9d0';

const SAMPLE_LOG = [
  `${SHA_A}\t1765522800\tAvi\ttighten su playbook locking rules`,
  'apps/operator/prompts/papercusp-su-engineer.tools.md',
  'apps/operator/prompts/operator.persona.md',
  '',
  `${SHA_B}\t1765436400\tworker-bee\tworker: respect\tvalidator handoff`,
  'libs/papercusp/packages/harness/prompts/worker.md',
].join('\n');

describe('parsePromptEditLog', () => {
  it('yields one entry per (commit, file) with commit time in ms', () => {
    const edits = parsePromptEditLog(SAMPLE_LOG);
    expect(edits).toHaveLength(3);
    expect(edits[0]).toEqual({
      sha: SHA_A,
      tsMs: 1765522800_000,
      author: 'Avi',
      subject: 'tighten su playbook locking rules',
      file: 'apps/operator/prompts/papercusp-su-engineer.tools.md',
    });
    expect(edits[1].file).toBe('apps/operator/prompts/operator.persona.md');
    // A tab INSIDE the subject stays part of the subject.
    expect(edits[2]).toMatchObject({
      sha: SHA_B,
      author: 'worker-bee',
      subject: 'worker: respect\tvalidator handoff',
      file: 'libs/papercusp/packages/harness/prompts/worker.md',
    });
  });

  it('tolerates empty input, trailing blanks, and malformed headers', () => {
    expect(parsePromptEditLog('')).toEqual([]);
    expect(parsePromptEditLog('\n\n')).toEqual([]);
    // A file line with no preceding valid header is dropped, not misattributed.
    expect(parsePromptEditLog('not-a-sha\t123\tx\ty\nsome/file.md')).toEqual([]);
    // A header with a garbage timestamp invalidates its file group only.
    const mixed = [`${SHA_A}\tnot-a-ts\tAvi\tbad`, 'a.md', '', `${SHA_B}\t1700000000\tAvi\tgood`, 'b.md'].join('\n');
    expect(parsePromptEditLog(mixed)).toEqual([
      { sha: SHA_B, tsMs: 1700000000_000, author: 'Avi', subject: 'good', file: 'b.md' },
    ]);
  });
});

describe('PROMPT_SCAN_GIT_ARGS', () => {
  it('builds the log invocation the parser expects, pathspec-bounded', () => {
    const args = PROMPT_SCAN_GIT_ARGS(PROMPT_SOURCE_PATHS, 14);
    expect(args[0]).toBe('log');
    expect(args).toContain('--since=14.days');
    expect(args).toContain('--name-only');
    expect(args).toContain('--no-merges');
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(args.slice(sep + 1)).toEqual([...PROMPT_SOURCE_PATHS]);
  });
});

describe('scanRepoPromptEdits', () => {
  it('offers every (commit, file) pair to the ledger with commit-time backfill', async () => {
    const recorded: RecordBehaviorChangeInput[] = [];
    const result = await scanRepoPromptEdits({
      workspaceId: 'ws-scan',
      runGitLog: async () => SAMPLE_LOG,
      record: async (input) => {
        recorded.push(input);
        return `id-${recorded.length}`;
      },
    });
    expect(result).toEqual({ edits: 3, recorded: 3 });
    expect(recorded[0]).toMatchObject({
      workspaceId: 'ws-scan',
      source: 'repo-scan',
      action: 'edit',
      targetKind: 'prompt-file',
      target: 'apps/operator/prompts/papercusp-su-engineer.tools.md',
      diffRef: SHA_A,
      actor: 'Avi',
      recordedAtMs: 1765522800_000,
    });
  });

  it('counts deduped offers (record → null) separately from recorded ones', async () => {
    const seen = new Set<string>();
    const result = await scanRepoPromptEdits({
      workspaceId: 'ws-scan',
      runGitLog: async () => `${SAMPLE_LOG}\n\n${SAMPLE_LOG}`,
      record: async (input) => {
        const key = `${input.diffRef}:${input.target}`;
        if (seen.has(key)) return null;
        seen.add(key);
        return key;
      },
    });
    expect(result).toEqual({ edits: 6, recorded: 3 });
  });

  it('clamps the window and passes it to git log', async () => {
    let captured: number | undefined;
    await scanRepoPromptEdits(
      {
        workspaceId: 'ws-scan',
        runGitLog: async (_paths, days) => {
          captured = days;
          return '';
        },
        record: async () => null,
      },
      { sinceDays: 5000 },
    );
    expect(captured).toBe(90);
  });
});
