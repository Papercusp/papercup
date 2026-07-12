/**
 * EI-9970 recurrence guard — readNewLines' prompt/response/tool-call
 * counting against a FIXTURE transcript, exercising the exact bug class
 * from the 2026-07-12 fleet retrospective: sessions:list's `turns` field
 * (a bare session_turns row count) got read as "how many turns did this
 * session take" when it only counts a filtered TEXT-TURNS-ONLY subset —
 * and a raw per-line count of 'assistant' JSONL records is EQUALLY
 * misleading, because Claude Code can split ONE logical model response
 * across several separate 'assistant' lines that share one message.id
 * (a thinking-only stub line, one line per tool_use block, then the text
 * line). This fixture pins that a single split response counts as exactly
 * ONE response, real prompts count once each, tool_result carrier lines
 * never count as prompts, and tool_use blocks count as real tool calls —
 * against a small hand-built JSONL fixture, not a live transcript (so this
 * can never silently rot with a client's actual line shapes the way a
 * "looked right once" manual audit did).
 *
 * FS-only (mkdtemp fixture file, no PG) — same convention as
 * session-ingest-walker.test.ts's jsonlAtDepth tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNewLines, classifyClaudeLine, parseClaudeLine } from './session-ingest';

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

/** A hand-built session mirroring the EI-9970 ground-truth shape:
 *   - 2 real user prompts
 *   - 1 tool_result-carrying synthetic user line (must NOT count as a prompt)
 *   - response #1 SPLIT across 3 raw JSONL lines sharing message.id 'msg_1'
 *     (thinking-only stub → 2x tool_use → text) — must count as ONE response,
 *     with 2 real tool calls.
 *   - response #2 is a single text-only line, message.id 'msg_2' — ONE
 *     response, zero tool calls.
 * Expected: promptCount=2, responseCount=2, toolCallCount=2, turns (stored
 * session_turns rows) = 2 prompts + 2 text-bearing assistant lines = 4
 * (the msg_1 thinking-only and tool_use-only lines produce NO stored turn —
 * exactly the gap `turns` alone cannot see, which response_count/
 * tool_call_count now cover). */
const FIXTURE_LINES = [
  { type: 'user', message: { role: 'user', content: 'fix the login bug please' } },
  {
    type: 'assistant',
    message: { role: 'assistant', id: 'msg_1', content: [{ type: 'thinking', thinking: 'let me look' }] },
  },
  {
    type: 'assistant',
    message: { role: 'assistant', id: 'msg_1', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] },
  },
  {
    type: 'assistant',
    message: { role: 'assistant', id: 'msg_1', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ran it' }] },
  },
  {
    type: 'assistant',
    message: { role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'Found + fixed the bug in auth.ts.' }] },
  },
  { type: 'user', message: { role: 'user', content: 'great, ship it' } },
  {
    type: 'assistant',
    message: { role: 'assistant', id: 'msg_2', content: [{ type: 'text', text: 'Shipped — deployed to staging.' }] },
  },
];

describe('readNewLines prompt/response/tool-call counting (EI-9970)', () => {
  it('a split multi-line Claude response counts as ONE response, not one-per-line', async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-ingest-dedup-'));
    const file = join(dir, 'fixture.jsonl');
    await writeFile(file, FIXTURE_LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const result = await readNewLines(file, 0, parseClaudeLine, classifyClaudeLine, null);

    expect(result.promptCount).toBe(2); // 2 real prompts; the 2 tool_result carriers excluded
    expect(result.responseCount).toBe(2); // msg_1's 3 lines dedup to 1; msg_2 is its own
    expect(result.toolCallCount).toBe(2); // Read + Bash
    expect(result.turns).toHaveLength(4); // 2 prompts + 2 TEXT-bearing assistant lines (session_turns rows)
    expect(result.lastInferenceId).toBe('msg_2');
  });

  it('a response split across TWO separate ingest ticks still dedups via the carried lastInferenceId cursor', async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-ingest-dedup-'));
    const file = join(dir, 'fixture.jsonl');
    const firstHalf = FIXTURE_LINES.slice(0, 3); // prompt + msg_1's thinking-stub + first tool_use
    const secondHalf = FIXTURE_LINES.slice(3); // rest, including msg_1's remaining lines + msg_2
    await writeFile(file, firstHalf.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const tick1 = await readNewLines(file, 0, parseClaudeLine, classifyClaudeLine, null);
    expect(tick1.responseCount).toBe(1); // msg_1's first response-bearing line (the tool_use)
    expect(tick1.lastInferenceId).toBe('msg_1');

    // Simulate the rest of the file landing (append, as a live JSONL would).
    await writeFile(file, [...firstHalf, ...secondHalf].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const tick2 = await readNewLines(file, tick1.newOffset, parseClaudeLine, classifyClaudeLine, tick1.lastInferenceId);

    // msg_1's remaining lines (tool_use + text) must NOT be double-counted as
    // a new response just because they landed in a later tick — the cursor
    // carried across the tick boundary is exactly what prevents that.
    expect(tick2.responseCount).toBe(1); // only msg_2 is genuinely new
    expect(tick1.responseCount + tick2.responseCount).toBe(2); // matches the single-tick total above
  });

  it('an empty/no-signal file yields all-zero counts, never throws', async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-ingest-dedup-'));
    const file = join(dir, 'empty.jsonl');
    await writeFile(file, '');
    const result = await readNewLines(file, 0, parseClaudeLine, classifyClaudeLine, null);
    expect(result).toMatchObject({ promptCount: 0, responseCount: 0, toolCallCount: 0, lastInferenceId: null });
  });
});
