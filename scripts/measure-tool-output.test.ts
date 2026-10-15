import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { capFor, contentBytes, measure } from './measure-tool-output.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'measure-tool-output.mjs');
const NOW = Date.parse('2026-10-15T09:00:00Z');
const START = NOW - 24 * 3600_000;
const base = NOW - 600_000;
const time = (seconds = 0) => new Date(base + seconds * 1000).toISOString();
const byte = (s: string) => Buffer.byteLength(s);
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture(claude: unknown[] = [], codex: unknown[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'tool-output-measure-'));
  homes.push(home);
  for (const client of ['claude', 'codex']) mkdirSync(join(home, client));
  const roots = [{ client: 'claude', path: join(home, 'claude') }, { client: 'codex', path: join(home, 'codex') }];
  const claudeFile = join(roots[0].path, 'session.jsonl');
  const codexFile = join(roots[1].path, 'rollout-fixture.jsonl');
  const save = (file: string, rows: unknown[]) => writeFileSync(file, rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  save(claudeFile, claude); save(codexFile, codex);
  return { home, roots, claudeFile, codexFile };
}
const assistant = (id: string, seconds: number, blocks: unknown[] = []) => ({ timestamp: time(seconds), type: 'assistant', message: { id, content: blocks } });
const use = (id: string, name = 'Bash', input = { command: 'cat file' }) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: unknown, seconds: number) => ({
  timestamp: time(seconds), type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
const call = (id: string, name: string, input: unknown, seconds: number) => ({
  timestamp: time(seconds), type: 'response_item', payload: { type: name === 'exec' ? 'custom_tool_call' : 'function_call', call_id: id, name,
    ...(name === 'exec' ? { input } : { arguments: JSON.stringify(input) }) },
});
const output = (id: string, body: unknown, seconds: number, custom = false) => ({
  timestamp: time(seconds), type: 'response_item', payload: { type: custom ? 'custom_tool_call_output' : 'function_call_output', call_id: id, output: body },
});
const usage = (n: number, seconds: number) => ({
  timestamp: time(seconds), type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { input_tokens: 100, output_tokens: 10 }, total_token_usage: { input_tokens: n * 100, output_tokens: n * 10 } } },
});
const run = (f: ReturnType<typeof fixture>, extra = {}) => measure(f.roots, 24, { now: NOW, ...extra });

describe('measure-tool-output raw transcript instrument', () => {
  it('TE-MEASURE-COUNTS / BYTES: exact UTF-8 result counts and byte percentiles per client and tool', async () => {
    const texts = ['a', 'é', '漢', '🙂'];
    const f = fixture([
      assistant('m1', 0, texts.map((_, i) => use('c' + i, i === 3 ? 'Read' : 'Bash'))),
      ...texts.map((s, i) => result('c' + i, [{ type: 'text', text: s }], 1)),
    ], [
      call('x1', 'exec_command', { cmd: 'cat one' }, 0), output('x1', 'é🙂', 1),
      call('x2', 'exec', 'text(1)', 2), output('x2', [{ type: 'text', text: 'xy' }], 3, true),
    ]);
    const r = await run(f);
    expect(r.clients.claude.results).toBe(4);
    expect(r.clients.claude.bytes).toBe(10);
    expect(r.clients.claude.size).toEqual({ count: 4, p50: 3, p90: 4, p95: 4, p99: 4, max: 4 });
    expect(r.clients.claude.tools.find((x) => x.tool === 'Bash')).toMatchObject({
      results: 3, bytes: 6, size: { p50: 2, p95: 3 },
    });
    expect(r.clients.claude.tools.find((x) => x.tool === 'Read')).toMatchObject({ results: 1, bytes: 4 });
    expect(r.clients.codex.results).toBe(2);
    expect(r.clients.codex.bytes).toBe(8);
    expect(r.clients.codex.tools.map((x) => x.tool)).toEqual(['code-mode-exec', 'exec_command']);
    expect(r.results).toBe(6);
    expect(r.bytes).toBe(18);
    expect(contentBytes([{ type: 'text', text: 'é' }, { type: 'image', source: { data: 'x' } }]))
      .toBe(2 + byte(JSON.stringify({ type: 'image', source: { data: 'x' } })));
  });

  it('TE-MEASURE-REREAD: later model responses, not tool count, determine replay bytes', async () => {
    const f = fixture([
      assistant('m1', 0, [use('a'), use('b', 'Read')]),
      assistant('m1', .1, [{ type: 'thinking', thinking: 'streamed block' }]),
      result('a', 'é', 1), result('b', 'abc', 1),
      assistant('m2', 2), assistant('m3', 3),
      { timestamp: time(4), type: 'system', subtype: 'compact_boundary' },
      assistant('m4', 5),
    ], [
      usage(1, 0), call('c1', 'exec_command', { cmd: 'cat' }, 1), output('c1', '1234', 2),
      usage(2, 3), usage(2, 3.1), // repeated usage notification
      { timestamp: time(3.2), type: 'event_msg', payload: { type: 'token_count', info: null } },
      usage(3, 4), { timestamp: time(5), type: 'compacted' }, usage(1, 6),
    ]);
    const r = await run(f);
    expect(r.clients.claude.rereadBytes).toBe((2 + 3) * 2);
    expect(r.clients.claude.modelCalls).toBe(4);
    expect(r.clients.codex.rereadBytes).toBe(4 * 2);
    expect(r.clients.codex.modelCalls).toBe(4);
    expect(r.rereadBytes).toBe(18);
    expect(r.sourceCoverage.duplicateRequests).toBe(2);
    expect(r.sourceCoverage.nativeCompactions).toBe(2);
  });

  it('TE-MEASURE-CAPS: distinguishes outer exec, nested shell, and door, including overlapping caps', async () => {
    const nested = JSON.stringify({ chunk_id: 'x', original_token_count: 5000, output: 'Warning: truncated output (original token count: 5000)\nabc' });
    const outer = 'Script completed\nWall time 1.0 seconds\nOutput:\nWarning: truncated output (original token count: 8000)\n' + nested;
    const door = JSON.stringify({ answer: 'kept', _projection: { kind: 'bounded-payload', truncated: true } });
    expect(capFor('codex', 'code-mode-exec', outer)).toEqual(['codex-outer-exec', 'nested-shell']);
    expect(capFor('codex', 'code-mode-exec', 'Script completed\nWall time 1.0 seconds\nOutput:\n' + nested)).toEqual(['nested-shell']);
    expect(capFor('claude', 'mcp__x', door)).toEqual(['papercusp-door']);
    expect(capFor('codex', 'code-mode-exec', [{ type: 'text', text: door }])).toEqual(['papercusp-door']);
    expect(capFor('claude', 'mcp__x', '[projection: pick results[].id → 75% saved]')).toEqual([]);
    expect(capFor('codex', 'code-mode-exec', 'The code checks for tokens truncated.')).toEqual([]);
    const f = fixture([assistant('m1', 0, [use('a', 'mcp__x')]), result('a', door, 1)], [
      call('c1', 'exec', 'text(await tools.exec_command({cmd:"cat"}))', 0), output('c1', outer, 1, true),
    ]);
    const r = await run(f);
    expect(r.truncation.results).toBe(2);
    expect(r.truncation.byCap['codex-outer-exec'].results).toBe(1);
    expect(r.truncation.byCap['nested-shell'].results).toBe(1);
    expect(r.truncation.byCap['papercusp-door'].results).toBe(1);
    expect(r.clients.codex.tools[0].truncation.byCap['nested-shell'].shareOfResults).toBe(1);
  });

  it('TE-MEASURE-RERUN: only the same invocation inside the declared short window, with actual repeat bytes', async () => {
    const cut = 'kept\n[result-door: spilled]';
    const f = fixture([
      assistant('m1', 0, [use('a')]), result('a', cut, 1),
      assistant('m2', 2, [use('unrelated', 'Bash', { command: 'cat other-file' })]),
      result('unrelated', 'other', 3),
      assistant('m3', 121, [use('retry')]), result('retry', 'new output!', 122), // exactly 120s
      assistant('m4', 130, [use('b', 'Read')]), result('b', cut, 131),
      assistant('m5', 252, [use('too-late', 'Read')]), result('too-late', 'late', 253),
    ], [
      call('c1', 'exec_command', { cmd: 'cat', max_output_tokens: 10 }, 0),
      output('c1', 'Warning: truncated output (original token count: 100)', 1),
      call('c2', 'exec_command', { cmd: 'cat', max_output_tokens: 100 }, 2), output('c2', '🙂', 3),
    ]);
    const r = await run(f);
    expect(r.rerunWindowSeconds).toBe(120);
    expect(r.clients.claude.reruns).toEqual({ callsAfterTruncation: 1, bytesAfterTruncation: 11 });
    expect(r.clients.codex.reruns).toEqual({ callsAfterTruncation: 1, bytesAfterTruncation: 4 });
    expect(r.clients.claude.tools.find((x) => x.tool === 'Read').reruns.callsAfterTruncation).toBe(0);
    expect(r.truncation.byCap['papercusp-door'].reruns).toBe(1);
  });

  it('TE-MEASURE-BASELINE: bounds results by record time, resolves old calls, excludes unknown/future times and dedupes raw paths/results', async () => {
    const oldCall = assistant('old', 0, [use('a')]);
    oldCall.timestamp = new Date(START - 1000).toISOString();
    const boundary = result('a', 'in', 0); boundary.timestamp = new Date(START).toISOString();
    const old = result('b', 'old', 0); old.timestamp = new Date(START - 1).toISOString();
    const future = result('c', 'future', 0); future.timestamp = new Date(NOW + 1).toISOString();
    const unknown = result('d', 'unknown', 0); delete unknown.timestamp;
    const f = fixture([oldCall, boundary, boundary, old, future, unknown, '{bad json']);
    const r = await measure([...f.roots, f.roots[0]], 24, { now: NOW });
    expect(r.measuredAt).toBe(new Date(NOW).toISOString());
    expect(r.window).toEqual({ start: new Date(START).toISOString(), end: new Date(NOW).toISOString() });
    expect(r.clients.claude.tools[0]).toMatchObject({ tool: 'Bash', results: 1, bytes: 2 });
    expect(r.sourceCoverage).toMatchObject({ parseErrors: 1, duplicateResults: 1, resultsWithoutTimestamp: 1, futureResults: 1 });
    expect(r.sourceCoverage.diagnostics.duplicatePaths).toBe(1);
  });

  it('reports unavailable roots, stale-file discovery omissions and empty populations explicitly', async () => {
    const f = fixture();
    utimesSync(f.claudeFile, new Date(START - 1000), new Date(START - 1000));
    const r = await measure([...f.roots, { client: 'claude', path: join(f.home, 'missing') }], 24, { now: NOW });
    expect(r.sourceCoverage.roots.find((x) => x.path.endsWith('/missing'))).toMatchObject({ status: 'unavailable', errors: 1 });
    expect(r.sourceCoverage.roots[0].skippedBeforeWindow).toBe(1);
    expect(r.clients.claude.size).toEqual({ count: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 });
    expect(r.rereadBytes).toBe(0);
  });

  it('CLI persists the dated 24h baseline with a named source window and validates options', () => {
    const f = fixture(), out = join(f.home, 'baseline.json');
    const stdout = execFileSync(process.execPath, [SCRIPT, '--since', '24h', '--claude-root', f.roots[0].path, '--codex-root', f.roots[1].path, '--out', out], { encoding: 'utf8' });
    const persisted = JSON.parse(readFileSync(out, 'utf8'));
    expect(persisted).toEqual(JSON.parse(stdout));
    expect(persisted.windowHours).toBe(24);
    expect(Date.parse(persisted.window.end) - Date.parse(persisted.window.start)).toBe(24 * 3600_000);
    expect(persisted.sourceCoverage.roots).toHaveLength(2);
    expect(persisted.method.bytes).toContain('No tokenizer ran');
    expect(() => execFileSync(process.execPath, [SCRIPT, '--out'], { stdio: 'pipe' })).toThrow();
    expect(() => execFileSync(process.execPath, [SCRIPT, '--hours', '-1'], { stdio: 'pipe' })).toThrow();
  });
});
