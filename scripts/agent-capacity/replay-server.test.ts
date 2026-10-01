import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeChunk, encodeChunk, fingerprintRequest, type RecordedExchange } from './record-proxy';
import {
  execSessionRewriter,
  newReplayState,
  reportedExecSessionIds,
  parseExchanges,
  parseReplayUrl,
  replaceAcross,
  rewriteExchange,
  sseEvents,
  startReplayServer,
  takeExchange,
  type ReplayServer,
  type ServedRecord,
} from './replay-server';

const MSG = '/v1/messages?beta=true';

function ex(seq: number, over: Partial<RecordedExchange> & { model?: string; messages?: number; tools?: number; body?: string[] } = {}): RecordedExchange {
  const body = over.body ?? [`event: message_start\ndata: {"seq":${seq}}\n\n`, 'event: message_stop\ndata: {}\n\n'];
  return {
    seq,
    sessionId: 's1',
    startedAt: '2026-09-30T00:00:00.000Z',
    method: over.method ?? 'POST',
    path: over.path ?? MSG,
    req: { bytes: 10, sha256: 'x', model: over.model ?? 'm', stream: true, messages: over.messages ?? 2, tools: over.tools ?? 20 },
    status: over.status ?? 200,
    contentType: over.contentType === undefined ? 'text/event-stream; charset=utf-8' : over.contentType,
    ttfbMs: 0,
    totalMs: over.totalMs ?? 0,
    resBytes: 0,
    chunks: over.chunks ?? body.map((b, i) => encodeChunk(i * 5, Buffer.from(b))),
  };
}

const req = (model: string | null, messages: number | null, tools: number | null, p = MSG, method = 'POST') => ({
  method,
  path: p,
  fp: { bytes: 1, sha256: 'y', model, stream: true, messages, tools },
});

describe('takeExchange', () => {
  it('prefers an exact fingerprint over an earlier shape-only match', () => {
    // Main thread (20 tools) and a subagent (14 tools) interleave; the subagent request
    // arrives first but must not steal the main thread's recorded reply.
    const st = newReplayState('s1', 'a', [ex(0, { messages: 2, tools: 20 }), ex(1, { messages: 2, tools: 14 })]);
    expect(takeExchange(st, req('m', 2, 14))).toMatchObject({ tier: 'exact', exchange: { seq: 1 } });
    expect(takeExchange(st, req('m', 2, 20))).toMatchObject({ tier: 'exact', exchange: { seq: 0 } });
    expect(st.counts).toEqual({ exact: 2, shape: 0, path: 0, exhausted: 0 });
  });

  it('serves the earliest unconsumed exact match, so a recorded 502 then its retry replay in order', () => {
    const st = newReplayState('s1', 'a', [ex(0, { status: 502, messages: 10 }), ex(1, { status: 200, messages: 10 })]);
    expect(takeExchange(st, req('m', 10, 20))?.exchange.status).toBe(502);
    expect(takeExchange(st, req('m', 10, 20))?.exchange.status).toBe(200);
  });

  it('falls back to shape, then path, then reports exhaustion', () => {
    const st = newReplayState('s1', 'a', [ex(0, { model: 'm', messages: 4 }), ex(1, { model: 'other', messages: 9 })]);
    expect(takeExchange(st, req('m', 99, 20))?.tier).toBe('shape');
    expect(takeExchange(st, req('m', 99, 20))?.tier).toBe('path');
    expect(takeExchange(st, req('m', 99, 20))).toBeNull();
    expect(takeExchange(st, req('m', 2, 20, '/v1/other'))).toBeNull();
    expect(st.counts).toEqual({ exact: 0, shape: 1, path: 1, exhausted: 2 });
  });

  it('never matches across method or path', () => {
    const st = newReplayState('s1', 'a', [ex(0, { method: 'HEAD', path: '/api/hello' })]);
    expect(takeExchange(st, req(null, null, null, '/api/hello', 'GET'))).toBeNull();
    expect(takeExchange(st, req(null, null, null, '/api/hello', 'HEAD'))?.exchange.seq).toBe(0);
  });
});

describe('parseReplayUrl / parseExchanges', () => {
  it('splits base, instance and the CLI-appended path', () => {
    expect(parseReplayUrl('/r/claude-exc-1-2026/a7/v1/messages?beta=true')).toEqual({ sessionId: 'claude-exc-1-2026', instance: 'a7', rest: MSG });
    expect(parseReplayUrl('/r/s1/a7')).toEqual({ sessionId: 's1', instance: 'a7', rest: '/' });
    expect(parseReplayUrl('/r/s1/a7?x=1')).toEqual({ sessionId: 's1', instance: 'a7', rest: '/?x=1' });
  });

  it('rejects traversal and non-replay urls', () => {
    expect(parseReplayUrl('/r/../a7/v1/messages')).toBeNull();
    expect(parseReplayUrl('/r/..%2Fetc/a7/x')).toBeNull();
    expect(parseReplayUrl('/v1/messages')).toBeNull();
  });

  it('orders exchanges by request seq, not completion order', () => {
    const jsonl = [ex(2), ex(0), ex(1)].map((e) => JSON.stringify(e)).join('\n') + '\n';
    expect(parseExchanges(jsonl).map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

// The recorded checkout and a replay's own: different lengths, so every boundary has to move.
const REC = '/home/u/.cache/agent-capacity/work/claude-x-20261001T003519';
const REP = '/home/u/.cache/agent-capacity/replay-work/R/s3-i0';

const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const jsonDelta = (index: number, partial_json: string) => sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } }, 'content_block_delta');
const bodyOf = (e: RecordedExchange) => Buffer.concat(e.chunks.map(decodeChunk)).toString('utf8');

/** Reassemble each streamed field the way a client does. */
function reassemble(e: RecordedExchange): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ev of sseEvents(e.chunks)) {
    const d = ev.data as Record<string, any> | null;
    if (d?.type === 'content_block_delta') out[`cb${d.index}`] = (out[`cb${d.index}`] ?? '') + (d.delta.partial_json ?? d.delta.text ?? '');
    else if (typeof d?.type === 'string' && d.type.endsWith('.delta')) out[d.type] = (out[d.type] ?? '') + d.delta;
  }
  return out;
}

describe('replaceAcross', () => {
  it('replaces a match split over several pieces and keeps the piece count', () => {
    const s = `cat ${REC}/a.txt && ls ${REC}`;
    const m2 = s.lastIndexOf(REC);
    // Cuts: inside match 1, between the matches, inside match 2.
    const cuts = [9, m2 - 6, m2 + 20];
    const pieces = [s.slice(0, cuts[0]), s.slice(cuts[0], cuts[1]), s.slice(cuts[1], cuts[2]), s.slice(cuts[2])];
    const out = replaceAcross(pieces, REC, REP);
    // A cut inside a match moves to the end of its replacement; a cut between matches shifts by
    // the length change of the matches before it.
    expect(out).toEqual([`cat ${REP}`, '/a.txt ', `&& ls ${REP}`, '']);
  });

  it('returns the same array when nothing matches', () => {
    const pieces = ['no ', 'path here'];
    expect(replaceAcross(pieces, REC, REP)).toBe(pieces);
  });
});

describe('rewriteExchange', () => {
  it('rewrites an Anthropic tool input whose path is split across input_json_delta events and chunks', () => {
    const input = JSON.stringify({ file_path: `${REC}/tests/test_x.py`, content: 'x' });
    const cut = input.indexOf(REC) + 17;
    const chunks = [
      encodeChunk(0, Buffer.from(sse({ type: 'message_start' }, 'message_start') + sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', input: {} } }, 'content_block_start'))),
      encodeChunk(40, Buffer.from(jsonDelta(1, input.slice(0, cut)))),
      // An event split across two network chunks: it completes at t=90.
      encodeChunk(70, Buffer.from(jsonDelta(1, input.slice(cut)).slice(0, 25))),
      encodeChunk(90, Buffer.from(jsonDelta(1, input.slice(cut)).slice(25) + sse({ type: 'message_stop' }, 'message_stop'))),
    ];
    const e = ex(0, { chunks, totalMs: 95 });
    const out = rewriteExchange(e, { from: REC, to: REP });
    expect(out).not.toBe(e);
    expect(JSON.parse(reassemble(out).cb1)).toEqual({ file_path: `${REP}/tests/test_x.py`, content: 'x' });
    expect(bodyOf(out)).not.toContain('agent-capacity/work/');
    // Same events, delivered when the recording completed each of them.
    expect(sseEvents(out.chunks)).toHaveLength(sseEvents(chunks).length);
    expect(out.chunks.map((c) => c.t)).toEqual([0, 40, 90]);
    expect(out.totalMs).toBe(95);
  });

  it('rewrites OpenAI Responses deltas and the full strings in their done events', () => {
    const patch = `*** Begin Patch\n*** Update File: ${REC}/src/a.ts\n@@\n-x\n+y\n*** End Patch`;
    const cut = patch.indexOf(REC) + 5;
    const item = { id: 'ctc_1', type: 'custom_tool_call', name: 'apply_patch', input: patch };
    const chunks = [
      encodeChunk(0, Buffer.from(sse({ type: 'response.custom_tool_call_input.delta', item_id: 'ctc_1', output_index: 1, delta: patch.slice(0, cut) }))),
      encodeChunk(10, Buffer.from(sse({ type: 'response.custom_tool_call_input.delta', item_id: 'ctc_1', output_index: 1, delta: patch.slice(cut) }))),
      encodeChunk(20, Buffer.from(sse({ type: 'response.output_item.done', output_index: 1, item }) + 'data: [DONE]\n\n')),
    ];
    const out = rewriteExchange(ex(0, { chunks }), { from: REC, to: REP });
    const want = patch.replace(REC, REP);
    expect(reassemble(out)['response.custom_tool_call_input.delta']).toBe(want);
    const done = sseEvents(out.chunks).find((e) => (e.data as any)?.type === 'response.output_item.done');
    expect((done?.data as any).item.input).toBe(want);
    expect(bodyOf(out).endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('rewrites a non-streamed JSON body and leaves an untouched exchange as the same object', () => {
    const json = ex(0, { contentType: 'application/json', chunks: [encodeChunk(5, Buffer.from(JSON.stringify({ content: [{ type: 'tool_use', input: { path: REC } }] })))] });
    expect(JSON.parse(bodyOf(rewriteExchange(json, { from: REC, to: REP }))).content[0].input.path).toBe(REP);
    const plain = ex(0);
    expect(rewriteExchange(plain, { from: REC, to: REP })).toBe(plain);
  });
});

// A Codex code-mode poll of a still-running process, as the model streams it.
const POLL = 'text(await tools.write_stdin({session_id:64250,chars:"",yield_time_ms:1000}));\n';
const pollChunks = (cut: number) => {
  const item = { id: 'ctc_2', type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: POLL };
  return [
    encodeChunk(0, Buffer.from(sse({ type: 'response.custom_tool_call_input.delta', item_id: 'ctc_2', output_index: 0, delta: POLL.slice(0, cut) }))),
    encodeChunk(10, Buffer.from(sse({ type: 'response.custom_tool_call_input.delta', item_id: 'ctc_2', output_index: 0, delta: POLL.slice(cut) }))),
    encodeChunk(20, Buffer.from(sse({ type: 'response.output_item.done', output_index: 0, item }) + 'data: [DONE]\n\n')),
  ];
};
const doneInput = (e: RecordedExchange) => (sseEvents(e.chunks).find((x) => (x.data as any)?.type === 'response.output_item.done')?.data as any).item.input;

describe('exec-session ids', () => {
  it('rewrites a recorded id split across deltas and in the done event, and never a longer id sharing its prefix', () => {
    const cut = POLL.indexOf('64250') + 2; // the id itself is split across the two deltas
    const out = rewriteExchange(ex(0, { chunks: pollChunks(cut) }), execSessionRewriter(new Map([['64250', '52575']])));
    const want = POLL.replace('64250', '52575');
    expect(reassemble(out)['response.custom_tool_call_input.delta']).toBe(want);
    expect(doneInput(out)).toBe(want);
    const prefix = ex(0, { chunks: pollChunks(cut) });
    expect(rewriteExchange(prefix, execSessionRewriter(new Map([['6425', '1']])))).toBe(prefix);
  });

  it('rewrites the JSON-argument spelling a function_call uses', () => {
    const args = JSON.stringify({ session_id: 64250, chars: '' });
    const body = JSON.stringify({ output: [{ type: 'function_call', name: 'write_stdin', arguments: args }] });
    const out = rewriteExchange(ex(0, { contentType: 'application/json', chunks: [encodeChunk(0, Buffer.from(body))] }), execSessionRewriter(new Map([['64250', '7']])));
    expect(JSON.parse(JSON.parse(bodyOf(out)).output[0].arguments)).toEqual({ session_id: 7, chars: '' });
  });

  it('reads ids only from the CLI tool outputs, never from model-written items or quoted command output', () => {
    const body = {
      input: [
        { type: 'custom_tool_call', call_id: 'c0', input: POLL }, // model-written: names a recorded id
        { type: 'custom_tool_call_output', call_id: 'c1', output: JSON.stringify({ output: 'grep says "session_id": 999', session_id: 52575 }) },
        { type: 'function_call_output', call_id: 'c3', output: [{ type: 'input_text', text: 'Process running with session ID 4111' }] },
        { type: 'custom_tool_call_output', call_id: 'c4', output: JSON.stringify({ session_id: 52575 }) },
      ],
    };
    expect(reportedExecSessionIds(Buffer.from(JSON.stringify(body)))).toEqual(['52575', '4111']);
    expect(reportedExecSessionIds(Buffer.from('not json'))).toEqual([]);
  });
});

describe('startReplayServer', () => {
  let corpus: string;
  let srv: ReplayServer;
  const logFile = () => path.join(corpus, 'served.jsonl');

  const post = (url: string, body: unknown, method = 'POST') =>
    new Promise<{ status: number; type: string | undefined; body: Buffer; ms: number }>((resolve, reject) => {
      const t0 = Date.now();
      const data = Buffer.from(JSON.stringify(body));
      const r = http.request(url, { method, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: Buffer.concat(parts), ms: Date.now() - t0 }));
      });
      r.on('error', reject);
      r.end(data);
    });

  const writeSession = (id: string, exchanges: RecordedExchange[]) => {
    mkdirSync(path.join(corpus, id), { recursive: true });
    writeFileSync(path.join(corpus, id, 'exchanges.jsonl'), exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  beforeEach(() => {
    corpus = mkdtempSync(path.join(tmpdir(), 'replay-server-'));
  });
  afterEach(async () => {
    await srv?.close();
    rmSync(corpus, { recursive: true, force: true });
  });

  it('replays recorded bytes, status and content type; answers 400 once the recording is used up', async () => {
    const utf8Split = Buffer.from('data: {"t":"é"}\n\n');
    const chunks = [encodeChunk(0, Buffer.from('event: a\n')), encodeChunk(1, utf8Split.subarray(0, 13)), encodeChunk(2, utf8Split.subarray(13))];
    expect(chunks[1].b64).toBeDefined(); // the split utf8 sequence was recorded as base64
    writeSession('s1', [ex(0, { chunks, messages: 1, tools: 3 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    const body = { model: 'm', stream: true, messages: [{}], tools: [{}, {}, {}] };
    const r1 = await post(`${srv.baseUrl('s1', 'a')}${MSG}`, body);
    expect(r1.status).toBe(200);
    expect(r1.type).toBe('text/event-stream; charset=utf-8');
    expect(r1.body.toString('utf8')).toBe('event: a\ndata: {"t":"é"}\n\n');

    const r2 = await post(`${srv.baseUrl('s1', 'a')}${MSG}`, body);
    expect(r2.status).toBe(400);
    expect(JSON.parse(r2.body.toString('utf8')).error.message).toMatch(/replay_exhausted/);

    await srv.close();
    const served = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    expect(served.map((s) => [s.tier, s.status, s.seq])).toEqual([
      ['exact', 200, 0],
      ['exhausted', 400, null],
    ]);
    expect(served[0].reqBytes).toBe(fingerprintRequest(Buffer.from(JSON.stringify(body))).bytes);
  });

  it('keeps separate consumption state per instance of the same recording', async () => {
    writeSession('s1', [ex(0, { messages: 1, tools: 0 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0 });
    const body = { model: 'm', messages: [{}], tools: [] };
    const [a, b] = await Promise.all([post(`${srv.baseUrl('s1', 'a')}${MSG}`, body), post(`${srv.baseUrl('s1', 'b')}${MSG}`, body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(srv.states().map((s) => s.counts.exact).sort()).toEqual([1, 1]);
  });

  it('rewrites the recorded work dir only for the instance registered for it, and logs it', async () => {
    const input = JSON.stringify({ file_path: `${REC}/out.txt` });
    const chunks = [encodeChunk(0, Buffer.from(jsonDelta(0, input.slice(0, 30)))), encodeChunk(5, Buffer.from(jsonDelta(0, input.slice(30))))];
    writeSession('s1', [ex(0, { chunks, messages: 1, tools: 0 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    srv.rewritePaths('s1', 'a', { from: REC, to: REP });
    const body = { model: 'm', messages: [{}], tools: [] };
    const [a, b] = await Promise.all([post(`${srv.baseUrl('s1', 'a')}${MSG}`, body), post(`${srv.baseUrl('s1', 'b')}${MSG}`, body)]);
    const pj = (buf: Buffer) => JSON.parse(reassemble(ex(0, { chunks: [encodeChunk(0, buf)] })).cb0);
    expect(pj(a.body)).toEqual({ file_path: `${REP}/out.txt` });
    expect(pj(b.body)).toEqual({ file_path: `${REC}/out.txt` });
    await srv.close();
    const served = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    expect(Object.fromEntries(served.map((s) => [s.instance, s.rewritten]))).toEqual({ a: true, b: false });
  });

  it('serves a Codex poll with the exec-session id THIS instance reported, and logs an id it never reported', async () => {
    const RESP = '/v1/responses';
    writeSession('s1', [ex(0, { path: RESP, chunks: pollChunks(30), messages: 2, tools: 0 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    const call = { type: 'custom_tool_call', call_id: 'c1', input: 'text(await tools.exec_command({cmd:"yarn test"}))' };
    const running = { model: 'm', tools: [], input: [call, { type: 'custom_tool_call_output', call_id: 'c1', output: JSON.stringify({ output: '', session_id: 52575 }) }] };
    const exited = { model: 'm', tools: [], input: [call, { type: 'custom_tool_call_output', call_id: 'c1', output: JSON.stringify({ output: 'ok', exit_code: 0 }) }] };
    const [a, b] = await Promise.all([post(`${srv.baseUrl('s1', 'a')}${RESP}`, running), post(`${srv.baseUrl('s1', 'b')}${RESP}`, exited)]);
    const servedInput = (buf: Buffer) => doneInput(ex(0, { chunks: [encodeChunk(0, buf)] }));
    expect(servedInput(a.body)).toBe(POLL.replace('64250', '52575'));
    expect(servedInput(b.body)).toBe(POLL);
    await srv.close();
    const served = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    const by = Object.fromEntries(served.map((s) => [s.instance, s]));
    expect(by.a.tier).toBe('exact');
    expect(by.a.execSessionIds).toEqual({ 64250: '52575' });
    expect(by.a.execSessionUnmapped).toBeUndefined();
    expect(by.b.execSessionIds).toBeUndefined();
    expect(by.b.execSessionUnmapped).toEqual(['64250']);
  });

  it('honours recorded delays scaled by speed', async () => {
    const chunks = [encodeChunk(60, Buffer.from('a')), encodeChunk(180, Buffer.from('b'))];
    writeSession('slow', [ex(0, { chunks, messages: 1, tools: 0 }), ex(1, { chunks, messages: 1, tools: 0 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 1 });
    const body = { model: 'm', messages: [{}], tools: [] };
    const real = await post(`${srv.baseUrl('slow', 'a')}${MSG}`, body);
    expect(real.body.toString()).toBe('ab');
    expect(real.ms).toBeGreaterThanOrEqual(170);
    await srv.close();
    srv = await startReplayServer({ corpusDir: corpus, speed: 0 });
    const fast = await post(`${srv.baseUrl('slow', 'a')}${MSG}`, body);
    expect(fast.body.toString()).toBe('ab');
    expect(fast.ms).toBeLessThan(120);
  });

  it('returns 404 for an unknown recording or a non-replay path', async () => {
    srv = await startReplayServer({ corpusDir: corpus, speed: 0 });
    expect((await post(`${srv.url}/r/nope/a${MSG}`, {})).status).toBe(404);
    expect((await post(`${srv.url}/v1/messages`, {})).status).toBe(404);
  });
});
