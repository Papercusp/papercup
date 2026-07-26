/**
 * P-002 wiring guard — `readNewLines` accumulating the per-tool/per-verb usage
 * rollup that the bash→tool substitution metric is computed from
 * (plan `bash-to-tool-substitution-2026-07-26`).
 *
 * The COUNTING RULES are unit-tested in
 * `lib/bash-substitution/usage-rollup.test.ts`. What is pinned HERE is the
 * thing those tests structurally cannot see: that the ingester actually calls
 * them, threads the result out, and keeps doing so across a tick boundary.
 * That gap is not hypothetical — the sibling bug this plan already ate was
 * exactly a correct counting function wired up wrong (result bytes were dated
 * from the caller's fallback instead of the record, so every byte was dropped
 * and the metric reported a confident, entirely wrong zero).
 *
 * FS-only (mkdtemp fixture, no PG) — same convention as
 * session-ingest-dedup.test.ts, whose fixture shape this mirrors.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNewLines, classifyClaudeLine, parseClaudeLine } from './session-ingest';
import { RESULT_BYTES_TOOL, extractLineUsage, usageKeyOf } from '../bash-substitution/usage-rollup';

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const TS = '2026-07-26T13:32:33.716Z';
const DAY = '2026-07-26';

/** One compound Bash call, one Read call, and a tool_result carrying 10 bytes. */
const FIXTURE_LINES = [
  {
    type: 'assistant',
    timestamp: TS,
    message: {
      role: 'assistant',
      id: 'msg_1',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: "sed -n '1,5p' a.ts | head -2" } }],
    },
  },
  {
    type: 'assistant',
    timestamp: TS,
    message: { role: 'assistant', id: 'msg_1', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } }] },
  },
  {
    type: 'user',
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '0123456789' }] },
  },
];

async function writeFixture(lines: unknown[], file: string): Promise<void> {
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('readNewLines usage rollup (P-002)', () => {
  it('accumulates per-call, per-verb and result-byte rows when the adapter supplies an extractor', async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-ingest-usage-'));
    const file = join(dir, 'fixture.jsonl');
    await writeFixture(FIXTURE_LINES, file);

    const { usage } = await readNewLines(file, 0, parseClaudeLine, classifyClaudeLine, null, extractLineUsage);

    // One Bash CALL, carrying TWO atoms — the calls/atoms split the whole
    // metric rests on (a compound line is one call, several atoms).
    expect(usage.get(usageKeyOf({ day: DAY, toolName: 'Bash', verb: null }))).toMatchObject({ calls: 1, atoms: 0 });
    expect(usage.get(usageKeyOf({ day: DAY, toolName: 'Bash', verb: 'sed' }))).toMatchObject({ atoms: 1 });
    expect(usage.get(usageKeyOf({ day: DAY, toolName: 'Bash', verb: 'head' }))).toMatchObject({ atoms: 1 });

    // A non-shell tool is counted as a call and contributes no verbs.
    expect(usage.get(usageKeyOf({ day: DAY, toolName: 'Read', verb: null }))).toMatchObject({ calls: 1, atoms: 0 });

    // REGRESSION PIN: result bytes must be dated from the RECORD, not dropped.
    expect(usage.get(usageKeyOf({ day: DAY, toolName: RESULT_BYTES_TOOL, verb: null }))?.resultBytes).toBe(10);
  });

  it('stays empty when the adapter supplies no extractor (non-Claude clients)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-ingest-usage-'));
    const file = join(dir, 'fixture.jsonl');
    await writeFixture(FIXTURE_LINES, file);

    const { usage, toolCallCount } = await readNewLines(file, 0, parseClaudeLine, classifyClaudeLine, null);

    // The EI-9970 counters keep working regardless — usage is purely additive.
    expect(toolCallCount).toBe(2);
    expect(usage.size).toBe(0);
  });

  it('keeps accumulating across a tick boundary rather than restarting', async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-ingest-usage-'));
    const file = join(dir, 'fixture.jsonl');
    await writeFixture(FIXTURE_LINES.slice(0, 1), file);

    const tick1 = await readNewLines(file, 0, parseClaudeLine, classifyClaudeLine, null, extractLineUsage);
    expect(tick1.usage.get(usageKeyOf({ day: DAY, toolName: 'Bash', verb: null }))?.calls).toBe(1);

    await writeFixture(FIXTURE_LINES, file);
    const tick2 = await readNewLines(file, tick1.newOffset, parseClaudeLine, classifyClaudeLine, tick1.lastInferenceId, extractLineUsage);

    // Each tick reports only ITS OWN delta — the rollup is summed on write
    // (ON CONFLICT ... calls + EXCLUDED.calls), so a tick re-reporting earlier
    // lines would double-count the whole window.
    expect(tick2.usage.get(usageKeyOf({ day: DAY, toolName: 'Bash', verb: null }))).toBeUndefined();
    expect(tick2.usage.get(usageKeyOf({ day: DAY, toolName: 'Read', verb: null }))?.calls).toBe(1);
  });

  it('never throws on a malformed line, and still counts the good ones', async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-ingest-usage-'));
    const file = join(dir, 'fixture.jsonl');
    await writeFile(file, `{"type":"assistant",  BROKEN\n${JSON.stringify(FIXTURE_LINES[0])}\n`);

    const { usage } = await readNewLines(file, 0, parseClaudeLine, classifyClaudeLine, null, extractLineUsage);
    expect(usage.get(usageKeyOf({ day: DAY, toolName: 'Bash', verb: null }))?.calls).toBe(1);
  });

  it('yields an empty rollup for an empty file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-ingest-usage-'));
    const file = join(dir, 'empty.jsonl');
    await writeFile(file, '');
    const { usage } = await readNewLines(file, 0, parseClaudeLine, classifyClaudeLine, null, extractLineUsage);
    expect(usage.size).toBe(0);
  });
});
