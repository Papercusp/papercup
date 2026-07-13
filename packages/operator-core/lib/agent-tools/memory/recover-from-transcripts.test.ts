import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// mineTranscript is the pure mining core (P-008); the handler just walks the
// transcripts tree and feeds it. Fixture reproduces the real wire shapes from
// the 2026-07-10 forensic pass — including the ESCAPED `\"ok\":false` result
// form that made the first grep return 0.
import recoverTool, { mineTranscript } from './recover-from-transcripts';

const line = (o: unknown): string => JSON.stringify(o);
const toolUse = (id: string, name: string, input: Record<string, unknown>, ts: string) =>
  line({ timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, text: string, isError = false, ts = '2026-07-10T18:00:05Z') =>
  line({ timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] } });

let dir: string;
let file: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miner-test-'));
  file = path.join(dir, 'session-abc.jsonl');
  const rows = [
    // 1. lost verbatim remember — ESCAPED ok:false (the grep-buster shape)
    toolUse('t1', 'mcp__papercusp-su__memory_remember',
      { content: 'lost fact one', kind: 'project', harness_slug: 'papercusp' }, '2026-07-10T18:00:00Z'),
    toolResult('t1', '{\\"ok\\":false,\\"reason\\":\\"memory_timeout\\"}'),
    // 2. failed remember the SAME session retried successfully → excluded
    toolUse('t2', 'memory:remember', { content: 'retried fact two', kind: 'user' }, '2026-07-10T18:01:00Z'),
    toolResult('t2', '{"ok":false,"reason":"mem0_unavailable"}'),
    toolUse('t3', 'memory:remember', { content: 'retried fact two', kind: 'user' }, '2026-07-10T18:09:00Z'),
    toolResult('t3', '{"ok":true,"ids":["11111111-1111-1111-1111-111111111111"]}'),
    // 3. lost text UPDATE → carries updateOf
    toolUse('t4', 'mcp__papercusp-su__memory_update',
      { id: '22222222-2222-2222-2222-222222222222', content: 'edited text' }, '2026-07-10T18:02:00Z'),
    toolResult('t4', 'handler_error: memory backend unavailable: embedder unavailable', true),
    // 4. successful remember — never a candidate
    toolUse('t5', 'memory:remember', { content: 'fine fact', kind: 'project' }, '2026-07-10T18:03:00Z'),
    toolResult('t5', '{"ok":true,"ids":["33333333-3333-3333-3333-333333333333"]}'),
    // 5. an unrelated tool with ok:false — ignored (name filter)
    toolUse('t6', 'plans:new', { slug: 'x' }, '2026-07-10T18:04:00Z'),
    toolResult('t6', '{"ok":false,"reason":"similar_exists"}'),
  ];
  await fs.writeFile(file, rows.join('\n') + '\n');
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('mineTranscript (memory:recover-from-transcripts P-008)', () => {
  it('finds lost writes incl. the escaped ok:false shape, tags retried-ok, extracts update_of', async () => {
    const found = await mineTranscript(file);
    expect(found).toHaveLength(3);

    const lost = found.find((c) => c.content === 'lost fact one');
    expect(lost).toBeDefined();
    expect(lost?.reason).toBe('memory_timeout');
    expect(lost?.scope).toBe('harness:papercusp');
    expect(lost?.kind).toBe('project');
    expect(lost?.retriedOkSameSession).toBe(false);

    const retried = found.find((c) => c.content === 'retried fact two');
    expect(retried?.retriedOkSameSession).toBe(true);

    const upd = found.find((c) => c.content === 'edited text');
    expect(upd?.updateOf).toBe('22222222-2222-2222-2222-222222222222');
    expect(upd?.reason.toLowerCase()).toContain('unavailable');
    expect(found.some((c) => c.content === 'fine fact')).toBe(false);
  });

  it('tolerates malformed lines and a missing file', async () => {
    const junk = path.join(dir, 'junk.jsonl');
    await fs.writeFile(junk, 'not json\n{"message":{"content":"also not a list"}}\n');
    await expect(mineTranscript(junk)).resolves.toEqual([]);
    await expect(mineTranscript(path.join(dir, 'nope.jsonl'))).resolves.toEqual([]);
  });

  it('flags a failure the write-ahead journal already parked (journaled:true)', async () => {
    // remember.ts stamps journaled:true whenever journalPendingWrite returned an
    // id — the fact is parked (the drain re-stores it), NOT lost. A failure with
    // NO stamp (journalId was null / pre-journal transcript) is genuinely at-risk.
    const jf = path.join(dir, 'session-journaled.jsonl');
    await fs.writeFile(jf, [
      toolUse('j1', 'memory:remember', { content: 'parked fact', kind: 'user' }, '2026-07-11T10:00:00Z'),
      toolResult('j1', '{"ok":false,"reason":"memory_timeout","journaled":true,"will_retry":true,"journal_id":"j-1"}'),
      toolUse('j2', 'memory:remember', { content: 'genuinely lost fact', kind: 'user' }, '2026-07-11T10:01:00Z'),
      toolResult('j2', '{"ok":false,"reason":"memory_timeout"}'),
    ].join('\n') + '\n');
    const found = await mineTranscript(jf);
    expect(found).toHaveLength(2);
    expect(found.find((c) => c.content === 'parked fact')?.alreadyJournaled).toBe(true);
    expect(found.find((c) => c.content === 'genuinely lost fact')?.alreadyJournaled).toBe(false);
  });
});

describe('memory:recover-from-transcripts handler (dry-run)', () => {
  it('excludes already-journaled failures from candidates and counts them', async () => {
    const scanDir = await fs.mkdtemp(path.join(os.tmpdir(), 'miner-handler-'));
    await fs.writeFile(path.join(scanDir, 'session-h.jsonl'), [
      toolUse('h1', 'memory:remember', { content: 'parked fact', kind: 'user' }, '2026-07-11T10:00:00Z'),
      toolResult('h1', '{"ok":false,"reason":"memory_timeout","journaled":true,"will_retry":true,"journal_id":"j-9"}'),
      toolUse('h2', 'memory:remember', { content: 'genuinely lost fact', kind: 'user' }, '2026-07-11T10:01:00Z'),
      toolResult('h2', '{"ok":false,"reason":"memory_timeout"}'),
    ].join('\n') + '\n');

    const prev = process.env.PAPERCUSP_SESSION_TRANSCRIPTS_DIR;
    process.env.PAPERCUSP_SESSION_TRANSCRIPTS_DIR = scanDir;
    try {
      const res = await recoverTool.handler({ window_hours: 48, confirm: false, limit: 50 } as never, {} as never);
      const out = JSON.parse((res as { content: { text: string }[] }).content[0].text);
      expect(out.mode).toBe('dry-run');
      expect(out.scanned_failures).toBe(2);
      expect(out.already_journaled).toBe(1);
      expect(out.candidates).toHaveLength(1);
      expect(out.candidates[0].content_preview).toBe('genuinely lost fact');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_SESSION_TRANSCRIPTS_DIR;
      else process.env.PAPERCUSP_SESSION_TRANSCRIPTS_DIR = prev;
      await fs.rm(scanDir, { recursive: true, force: true });
    }
  });
});
