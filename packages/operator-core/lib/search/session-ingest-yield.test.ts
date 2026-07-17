/**
 * WI-5218 recurrence guard — readNewLines' per-line parse loop now
 * cooperative-yields every LINE_YIELD_EVERY lines (event-loop-lag-monitor's
 * `cooperativeYield`) instead of running fully synchronously, to stop a
 * large transcript file (up to MAX_BYTES_PER_FILE_PER_TICK) from blocking
 * the bg-host main thread long enough to starve the routine ticker
 * (measured: 10-50/h loop-governor "event loop recovered" recoveries, scout
 * recombine timeouts, outbox-drain pass-timeouts — see WI-5218).
 *
 * This pins that inserting yield points across MULTIPLE yield-boundary
 * crossings does not change readNewLines' output in any way — every line is
 * still parsed exactly once, counts are not dropped or double-counted at a
 * boundary, and the returned byte offset still covers the whole file. A
 * future "optimization" that hoists per-line state outside the loop in a way
 * that breaks across an `await` point (e.g. captures a stale closure) would
 * trip this test.
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

describe('readNewLines cooperative-yield across a large file (WI-5218)', () => {
  it('parses every line correctly across several LINE_YIELD_EVERY (1000-line) yield boundaries', async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-ingest-yield-'));
    const file = join(dir, 'large.jsonl');

    // 3500 lines: alternating real user prompts and assistant text
    // responses, each with a distinct message.id — crosses the 1000-line
    // yield boundary 3 times within a single readNewLines call.
    const LINE_COUNT = 3500;
    const lines: string[] = [];
    for (let i = 0; i < LINE_COUNT; i += 1) {
      if (i % 2 === 0) {
        lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `prompt #${i}` } }));
      } else {
        lines.push(JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', id: `msg_${i}`, content: [{ type: 'text', text: `response #${i}` }] },
        }));
      }
    }
    const content = lines.join('\n') + '\n';
    await writeFile(file, content);

    const result = await readNewLines(file, 0, parseClaudeLine, classifyClaudeLine, null);

    // Every line produced a stored turn (all are real prompts/text responses).
    expect(result.turns).toHaveLength(LINE_COUNT);
    expect(result.promptCount).toBe(LINE_COUNT / 2);
    expect(result.responseCount).toBe(LINE_COUNT / 2);
    expect(result.toolCallCount).toBe(0);
    // The whole file was consumed — no line lost or double-read at a yield boundary.
    expect(result.newOffset).toBe(Buffer.byteLength(content, 'utf8'));
    // Turns are in file order and none were skipped/duplicated across a boundary.
    expect(result.turns[0]?.text).toBe('prompt #0');
    expect(result.turns[LINE_COUNT - 1]?.text).toBe(`response #${LINE_COUNT - 1}`);
    const uniqueTexts = new Set(result.turns.map((t) => t.text));
    expect(uniqueTexts.size).toBe(LINE_COUNT);
  });

  it('a follow-up tick starting mid-file (offset past a yield-sized chunk) still resumes correctly', async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-ingest-yield-'));
    const file = join(dir, 'large2.jsonl');
    const LINE_COUNT = 2200;
    const lines: string[] = [];
    for (let i = 0; i < LINE_COUNT; i += 1) {
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `prompt #${i}` } }));
    }
    const content = lines.join('\n') + '\n';
    await writeFile(file, content);

    const tick1 = await readNewLines(file, 0, parseClaudeLine, classifyClaudeLine, null);
    expect(tick1.turns).toHaveLength(LINE_COUNT);

    // Re-reading from the returned offset (idempotent tailer semantics) finds nothing new.
    const tick2 = await readNewLines(file, tick1.newOffset, parseClaudeLine, classifyClaudeLine, tick1.lastInferenceId);
    expect(tick2.turns).toHaveLength(0);
    expect(tick2.newOffset).toBe(tick1.newOffset);
  });
});
