import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeChunk, type RecordedExchange } from './record-proxy';
import type { Corpus, SessionMeta } from './record-session';
import { drive, selectSessions, sessionFor, summarize, toolOutcomesDiverge, versionMismatches } from './load-driver';

function meta(over: Partial<SessionMeta> & { id: string; profile?: 'light' | 'typical' | 'heavy'; repo?: string }): SessionMeta {
  const repo = over.repo ?? 'r';
  return {
    sessionId: over.id,
    corpusVersion: 1,
    task: { id: 't1', repo, profile: over.profile ?? 'light', prompt: 'Do the thing.' },
    repo: { name: repo, sha: 'abc', kind: 'k' },
    cli: over.cli ?? 'claude',
    cliVersion: 'v',
    claudeModel: 'sonnet',
    startedAt: '2026-09-30T00:00:00Z',
    wallMs: over.wallMs ?? 100,
    exitCode: over.exitCode === undefined ? 0 : over.exitCode,
    timedOut: over.timedOut ?? false,
    exchanges: 2,
    toolCalls: {},
    diffBytes: 0,
  };
}

describe('selection and scheduling', () => {
  const metas = [
    meta({ id: 'claude-b', profile: 'typical' }),
    meta({ id: 'claude-a' }),
    meta({ id: 'codex-a', cli: 'codex' }),
    meta({ id: 'claude-failed', exitCode: 1 }),
    meta({ id: 'claude-timeout', timedOut: true }),
  ];

  it('filters by cli/profile, drops failed or timed-out recordings, and sorts by id', () => {
    expect(selectSessions(metas, 'cli=claude', undefined).map((m) => m.sessionId)).toEqual(['claude-a', 'claude-b']);
    expect(selectSessions(metas, 'profile=light', undefined).map((m) => m.sessionId)).toEqual(['claude-a', 'codex-a']);
    expect(selectSessions(metas, 'cli=claude,cli=codex,profile=light', undefined).map((m) => m.sessionId)).toEqual(['claude-a', 'codex-a']);
  });

  it('takes explicit ids verbatim and rejects unknown ids or keys', () => {
    expect(selectSessions(metas, undefined, ['codex-a', 'claude-b']).map((m) => m.sessionId)).toEqual(['codex-a', 'claude-b']);
    expect(() => selectSessions(metas, undefined, ['nope'])).toThrow(/no recorded session/);
    expect(() => selectSessions(metas, 'model=x', undefined)).toThrow(/bad --select/);
  });

  it('round-robins sessions across slots and iterations', () => {
    const s = [meta({ id: 'a' }), meta({ id: 'b' }), meta({ id: 'c' })];
    expect([0, 1, 2, 3].map((slot) => sessionFor(s, slot, 0).sessionId)).toEqual(['a', 'b', 'c', 'a']);
    expect([0, 1, 2].map((it) => sessionFor(s, 1, it).sessionId)).toEqual(['b', 'c', 'a']);
  });

  it('calls a replay tool-diverged when its tool results or failures differ from the recording', () => {
    expect(toolOutcomesDiverge({ results: 6, errors: 1 }, { results: 6, errors: 1 })).toBe(false);
    expect(toolOutcomesDiverge({ results: 6, errors: 0 }, { results: 6, errors: 1 })).toBe(true);
    expect(toolOutcomesDiverge({ results: 6, errors: 0 }, { results: 5, errors: 0 })).toBe(true);
    // No recorded CLI log: nothing to compare against.
    expect(toolOutcomesDiverge(null, { results: 5, errors: 2 })).toBe(false);
  });

  it('names each CLI whose installed build is not one the sessions were recorded with', () => {
    const sessions = [
      { cli: 'claude' as const, cliVersion: '2.1.284 (Claude Code)' },
      { cli: 'codex' as const, cliVersion: 'codex-cli 0.159.2' },
      { cli: 'codex' as const, cliVersion: 'codex-cli 0.159.2' },
    ];
    const installed = (v: Record<string, string>) => (cli: string) => v[cli] ?? 'missing';
    expect(versionMismatches(sessions, installed({ claude: '2.1.284 (Claude Code)', codex: 'codex-cli 0.159.2' }))).toEqual([]);
    expect(versionMismatches(sessions, installed({ claude: '2.1.284 (Claude Code)', codex: 'codex-cli 0.157.1' }))).toEqual([
      { cli: 'codex', have: 'codex-cli 0.157.1', want: ['codex-cli 0.159.2'] },
    ]);
    expect(versionMismatches(sessions, installed({ codex: 'codex-cli 0.159.2' }))).toEqual([
      { cli: 'claude', have: 'missing', want: ['2.1.284 (Claude Code)'] },
    ]);
  });
});

// cgroup accounting and event-loop hygiene: session-process.test.ts (shared with record-session).

describe('drive (end to end with a fake CLI)', () => {
  let root: string;
  const oldPath = process.env.PATH;

  // A stand-in `claude`: sends the requests a two-turn session would (2 then 4 messages),
  // plus one extra when FAKE_EXTRA=1 so the replay diverges; prints the -p prompt it got.
  // Like the real CLI it runs the tool calls it is streamed: each tool_use input (reassembled
  // from input_json_delta fragments) is a Write of `file_path`, reported as a stream-json
  // tool_result line that is_error when the write fails.
  const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const base = process.env.ANTHROPIC_BASE_URL;
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const results = [];
const runTools = (text) => {
  const inputs = {};
  for (const line of text.split('\\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const j = JSON.parse(line.slice(6));
      if (j.type === 'content_block_delta' && j.delta.type === 'input_json_delta') inputs[j.index] = (inputs[j.index] || '') + j.delta.partial_json;
    } catch {}
  }
  for (const s of Object.values(inputs)) {
    const { file_path } = JSON.parse(s);
    let is_error = false, content = file_path;
    try { fs.writeFileSync(file_path, 'x'); } catch (e) { is_error = true; content = e.code; }
    results.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error, content }] } }));
  }
};
const call = async (n) => {
  const r = await fetch(base + '/v1/messages?beta=true', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', stream: true, messages: Array(n).fill({}), tools: Array(20).fill({}) }) });
  const text = await r.text();
  runTools(text);
  return [r.status, text];
};
(async () => {
  const out = [await call(2), await call(4)];
  if (process.env.FAKE_EXTRA === '1') out.push(await call(6));
  for (const l of results) console.log(l);
  console.log(JSON.stringify({ prompt, out, cfg: process.env.CLAUDE_CONFIG_DIR ? 'set' : 'unset' }));
  process.exit(out.every(([s]) => s === 200) ? 0 : 1);
})();
`;

  const corpus: Corpus = { version: 1, suffix: 'SUFFIX', timeoutSec: { light: 30, typical: 30, heavy: 30 }, repos: {}, tasks: [] };

  const exch = (seq: number, messages: number): RecordedExchange => ({
    seq,
    sessionId: 'claude-s1',
    startedAt: '2026-09-30T00:00:00Z',
    method: 'POST',
    path: '/v1/messages?beta=true',
    req: { bytes: 1, sha256: 'x', model: 'claude-sonnet-5-5', stream: true, messages, tools: 20 },
    status: 200,
    contentType: 'text/event-stream',
    ttfbMs: 0,
    totalMs: 0,
    resBytes: 0,
    chunks: [encodeChunk(0, Buffer.from(`data: reply-${seq}\n\n`))],
  });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'capdrv-e2e-'));
    mkdirSync(path.join(root, 'bin'));
    writeFileSync(path.join(root, 'bin', 'claude'), FAKE);
    chmodSync(path.join(root, 'bin', 'claude'), 0o755);
    process.env.PATH = `${path.join(root, 'bin')}:${oldPath}`;
    mkdirSync(path.join(root, 'cache', 'prepared', 'r'), { recursive: true });
    writeFileSync(path.join(root, 'cache', 'prepared', 'r', 'README'), 'repo');
    mkdirSync(path.join(root, 'corpus', 'claude-s1'), { recursive: true });
    writeFileSync(path.join(root, 'corpus', 'claude-s1', 'exchanges.jsonl'), [exch(1, 4), exch(0, 2)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  });
  afterEach(() => {
    process.env.PATH = oldPath;
    delete process.env.FAKE_EXTRA;
    rmSync(root, { recursive: true, force: true });
  });

  const run = (agents: number) =>
    drive({
      cacheDir: path.join(root, 'cache'),
      agents,
      sessions: [meta({ id: 'claude-s1' })],
      corpus,
      corpusDir: path.join(root, 'corpus'),
      outDir: path.join(root, 'out'),
      runId: 'T',
      speed: 0,
      staggerMs: 0,
      durationSec: 0,
      isolation: 'none',
      keepWork: false,
    });

  it('replays one recording to N concurrent agents, each with its own state, and cleans up', async () => {
    const runs = await run(3);
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      expect(r).toMatchObject({ exitCode: 0, timedOut: false, diverged: false, served: { exact: 2, shape: 0, path: 0, exhausted: 0 } });
      const printed = JSON.parse(readFileSync(path.join(root, 'out', 'sessions', `${r.instance}.cli.jsonl`), 'utf8'));
      expect(printed.prompt).toBe('Do the thing.\n\nSUFFIX');
      expect(printed.cfg).toBe('set');
      expect(printed.out.map((o: [number, string]) => o[1])).toEqual(['data: reply-0\n\n', 'data: reply-1\n\n']);
    }
    expect(readFileSync(path.join(root, 'out', 'agents.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(readFileSync(path.join(root, 'out', 'served.jsonl'), 'utf8').trim().split('\n')).toHaveLength(6);
    expect(() => readFileSync(path.join(root, 'cache', 'replay-work', 'T', 's0-i0', 'README'))).toThrow();
    expect(summarize(runs)).toMatchObject({ runs: 3, clean: 3, failed: 0, diverged: 0, served: { exact: 6, exhausted: 0 } });
  });

  it('sweep runs every selected session exactly once across the slots', async () => {
    for (const id of ['claude-s2', 'claude-s3']) {
      mkdirSync(path.join(root, 'corpus', id), { recursive: true });
      writeFileSync(path.join(root, 'corpus', id, 'exchanges.jsonl'), readFileSync(path.join(root, 'corpus', 'claude-s1', 'exchanges.jsonl')));
    }
    const runs = await drive({
      cacheDir: path.join(root, 'cache'),
      agents: 2,
      sessions: ['claude-s1', 'claude-s2', 'claude-s3'].map((id) => meta({ id })),
      corpus,
      corpusDir: path.join(root, 'corpus'),
      outDir: path.join(root, 'out'),
      runId: 'S',
      speed: 0,
      staggerMs: 0,
      durationSec: 3600,
      isolation: 'none',
      keepWork: false,
      sweep: true,
    });
    expect(runs.map((r) => r.sessionId).sort()).toEqual(['claude-s1', 'claude-s2', 'claude-s3']);
    expect(new Set(runs.map((r) => r.slot))).toEqual(new Set([0, 1]));
    expect(summarize(runs)).toMatchObject({ runs: 3, clean: 3, diverged: 0, served: { exact: 6, exhausted: 0 } });
  });

  it('flags a replay that ran past its recording as diverged and failed', async () => {
    process.env.FAKE_EXTRA = '1';
    const [r] = await run(1);
    expect(r).toMatchObject({ exitCode: 1, diverged: true, served: { exact: 2, exhausted: 1 } });
    expect(summarize([r])).toMatchObject({ clean: 0, failed: 1, diverged: 1 });
  });

  describe('a recording whose tool call names its own absolute checkout path', () => {
    // The recorded session ran in recWork and its Write named `${recWork}/out.txt`, streamed
    // as two input_json_delta fragments that split the path.
    let recWork: string;
    const writeRecording = (recordedToolError: boolean) => {
      const input = JSON.stringify({ file_path: `${recWork}/out.txt` });
      const cut = input.indexOf(recWork) + 10;
      const delta = (pj: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: pj } })}\n\n`;
      const toolTurn = { ...exch(0, 2), chunks: [encodeChunk(0, Buffer.from(delta(input.slice(0, cut)))), encodeChunk(3, Buffer.from(delta(input.slice(cut))))] };
      const dir = path.join(root, 'corpus', 'claude-s1');
      writeFileSync(path.join(dir, 'exchanges.jsonl'), [toolTurn, exch(1, 4)].map((e) => JSON.stringify(e)).join('\n') + '\n');
      writeFileSync(path.join(dir, 'cli.jsonl'), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: recordedToolError, content: 'ok' }] } }) + '\n');
    };
    const runWith = (workDir: string) =>
      drive({
        cacheDir: path.join(root, 'cache'),
        agents: 1,
        sessions: [{ ...meta({ id: 'claude-s1' }), workDir }],
        corpus,
        corpusDir: path.join(root, 'corpus'),
        outDir: path.join(root, 'out'),
        runId: 'W',
        speed: 0,
        staggerMs: 0,
        durationSec: 0,
        isolation: 'none',
        keepWork: true,
      });
    const toolResults = (instance: string) =>
      readFileSync(path.join(root, 'out', 'sessions', `${instance}.cli.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((j) => j.type === 'user')
        .map((j) => j.message.content[0]);

    beforeEach(() => {
      recWork = path.join(root, 'rec-work', 'claude-s1-20261001T003519');
    });

    it('rewrites the path so the replayed tool writes into the replay checkout, matching the recording', async () => {
      writeRecording(false);
      const [r] = await runWith(recWork);
      const replayWork = path.join(root, 'cache', 'replay-work', 'W', 's0-i0');
      expect(toolResults(r.instance)).toEqual([{ type: 'tool_result', is_error: false, content: `${replayWork}/out.txt` }]);
      expect(readFileSync(path.join(replayWork, 'out.txt'), 'utf8')).toBe('x');
      expect(r).toMatchObject({
        exitCode: 0,
        served: { exact: 2, exhausted: 0 },
        toolOutcomes: { recorded: { results: 1, errors: 0 }, replayed: { results: 1, errors: 0 } },
        toolDiverged: false,
        diverged: false,
      });
      const served = readFileSync(path.join(root, 'out', 'served.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(served.map((s) => s.rewritten)).toEqual([true, false]);
    });

    it('flags the replay diverged when its tool failed where the recording succeeded, though every request matched exact', async () => {
      // The meta names the wrong checkout, so nothing is rewritten and the Write targets the
      // recording's directory, which does not exist here: the bug this check exists to catch.
      writeRecording(false);
      const [r] = await runWith(path.join(root, 'elsewhere'));
      expect(toolResults(r.instance)).toEqual([{ type: 'tool_result', is_error: true, content: 'ENOENT' }]);
      expect(r).toMatchObject({
        exitCode: 0,
        served: { exact: 2, shape: 0, path: 0, exhausted: 0 },
        toolOutcomes: { recorded: { results: 1, errors: 0 }, replayed: { results: 1, errors: 1 } },
        toolDiverged: true,
        diverged: true,
      });
      expect(summarize([r])).toMatchObject({ clean: 0, diverged: 1, toolDiverged: 1 });
    });
  });
});
