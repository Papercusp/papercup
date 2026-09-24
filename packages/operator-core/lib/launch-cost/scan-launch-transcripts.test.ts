import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectTranscriptFiles,
  measureTranscriptFile,
  ownerIdFromPath,
  scanLaunchTranscripts,
  captureCompletedCarrySource,
  recheckCarrySourceSnapshot,
} from './scan-launch-transcripts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'launch-cost-scan-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Build `<root>/<owner>/projects/<project>/<session>.jsonl` and return its path. */
async function writeTranscript(
  owner: string,
  session: string,
  lines: unknown[],
  project = '-repo',
): Promise<string> {
  const dir = join(root, owner, 'projects', project);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${session}.jsonl`);
  await writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return filePath;
}

function usageEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-09-18T06:31:53.858Z',
    entrypoint: 'cli',
    version: '2.1.0',
    cwd: '/repo',
    sessionId: 'session-a',
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 128_745,
        cache_read_input_tokens: 103_666,
        output_tokens: 296,
      },
    },
    ...overrides,
  };
}

describe('completed native carry source capture', () => {
  const setup = async () => {
    const entries = [
      { type: 'session_meta', payload: { id: 'native-thread' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'native-turn' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'native-turn' } },
    ];
    const path = join(root, 'native.jsonl');
    const body = () => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(path, body());
    const thread = { id: 'native-thread', path, status: { type: 'idle' },
      turns: [{ id: 'native-turn', status: 'completed', error: null, itemsView: 'full', items: [] }] };
    const peer = { request: vi.fn(async () => ({ thread })), send: vi.fn(), close: vi.fn(async () => {}),
      done: Promise.resolve(), pid: () => 1 };
    return { entries, path, body, peer, thread };
  };
  it('waits for native teardown and captures exact bytes, without editing the source', async () => {
    const { peer, path } = await setup();
    const bytes = await readFile(path);
    const closing: string[] = [];
    peer.close.mockImplementation(async () => { closing.push('closed'); });
    peer.done = Promise.resolve().then(() => { closing.push('exited'); });
    const result = await captureCompletedCarrySource(peer, 'native-thread', 'native-turn');
    expect(closing.sort()).toEqual(['closed', 'exited']);
    expect(peer.request).toHaveBeenCalledWith({ method: 'thread/read', params: { threadId: 'native-thread', includeTurns: true } });
    expect(result.snapshot.bytes).toEqual(bytes);
    expect(await readFile(path)).toEqual(bytes);
    await expect(recheckCarrySourceSnapshot(result)).resolves.toBeUndefined();
  });
  it('reads only after close completes, so a native final flush is included', async () => {
    const { peer, path, body } = await setup();
    await writeFile(path, '');
    peer.close.mockImplementation(async () => { await writeFile(path, body()); });
    expect((await captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).snapshot.bytes.toString()).toBe(body());
  });
  it.each(['busy', 'wrong-thread', 'wrong-turn', 'failed', 'partial-view', 'relative-path', 'later-turn', 'duplicate-turn'])('rejects native %s before teardown', async fault => {
    const { peer, thread } = await setup();
    if (fault === 'busy') thread.status.type = 'active';
    if (fault === 'wrong-thread') thread.id = 'other';
    if (fault === 'wrong-turn') thread.turns[0].id = 'other';
    if (fault === 'failed') thread.turns[0].status = 'failed';
    if (fault === 'partial-view') thread.turns[0].itemsView = 'summary';
    if (fault === 'relative-path') thread.path = 'native.jsonl';
    if (fault === 'later-turn') thread.turns.push({ ...thread.turns[0], id: 'later' });
    if (fault === 'duplicate-turn') thread.turns.push(thread.turns[0]);
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow(/carry source/);
    expect(peer.close).not.toHaveBeenCalled();
  });
  it.each(['partial-record', 'empty', 'bad-json', 'wrong-header', 'duplicate-header', 'no-header', 'later-start', 'wrong-terminal', 'terminal-error'])('rejects %s in the original source', async fault => {
    const { peer, path, entries, body } = await setup();
    if (fault === 'wrong-header') entries[0].payload.id = 'other';
    if (fault === 'duplicate-header') entries.unshift(entries[0]);
    if (fault === 'no-header') entries.shift();
    if (fault === 'later-start') entries.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'later' } });
    if (fault === 'wrong-terminal') entries[2].payload.turn_id = 'other';
    if (fault === 'terminal-error') Object.assign(entries[2].payload, { status: 'failed' });
    await writeFile(path, fault === 'empty' ? '' : fault === 'bad-json' ? '{bad}\n' : body() + (fault === 'partial-record' ? '{' : ''));
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow();
  });
  it('propagates teardown failure before reading a source that otherwise looks valid', async () => {
    const { peer } = await setup();
    peer.close.mockRejectedValue(new Error('tracked teardown failed'));
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow('tracked teardown failed');
  });
  it('does not capture after a rejected native process-exit receipt', async () => {
    const { peer } = await setup();
    peer.done = Promise.reject(new Error('native exit failed')); void peer.done.catch(() => {});
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow('native exit failed');
  });
  it.each([NaN, Infinity, 0, -1, 65 * 1024 * 1024])('refuses unsafe byte cap %s before native reads', async cap => {
    const { peer } = await setup();
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn', cap)).rejects.toThrow(/byte cap/);
    expect(peer.request).not.toHaveBeenCalled();
  });
  it('honors the byte cap and refuses a symlinked source', async () => {
    const { peer, path, thread } = await setup();
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn', 1)).rejects.toThrow(/byte cap/);
    const link = join(root, 'link.jsonl'); await symlink(path, link); thread.path = link;
    await expect(captureCompletedCarrySource(peer, 'native-thread', 'native-turn')).rejects.toThrow();
  });
  it.each(['append', 'rewrite-same-length', 'truncate', 'partial-tail'])('rejects source %s before the next arm', async change => {
    const { peer, path, body } = await setup();
    const source = await captureCompletedCarrySource(peer, 'native-thread', 'native-turn');
    if (change === 'append') await appendFile(path, '{}\n');
    if (change === 'rewrite-same-length') await writeFile(path, body().replace('task_complete', 'task_completE'));
    if (change === 'truncate') await writeFile(path, '');
    if (change === 'partial-tail') await appendFile(path, '{');
    await expect(recheckCarrySourceSnapshot(source)).rejects.toThrow();
  });
});

describe('measureTranscriptFile — the streaming guarantee', () => {
  it('the real CLI refuses a passing target on partial usage and accepts the fully reported control', async () => {
    const path = await writeTranscript('su-cli', 'session-cli', [usageEntry({
      message: { model: 'claude-model', usage: { input_tokens: 2000 } },
    })]);
    const cli = fileURLToPath(new URL('../../../../scripts/measure-launch-cost.ts', import.meta.url));
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', cli, '--root', root, '--target', '1000000'], {
      encoding: 'utf8', timeout: 15000,
    });
    const partial = run();
    expect(partial.status).toBe(1);
    expect(partial.stderr).toContain('UNKNOWN target result');
    expect(partial.stdout).toContain('known lower bounds');
    expect(partial.stdout).not.toContain('PASS median');
    await writeFile(path, JSON.stringify(usageEntry()) + '\n');
    const complete = run();
    expect(complete.status).toBe(0);
    expect(complete.stdout).toContain('PASS median');
  });

  it('finds a usage row that sits far past any bounded read window', async () => {
    // ⚠ THE LOAD-BEARING TEST OF THIS FILE.
    // A real psu transcript opens with a ~580 KB system-prompt entry on ONE line. Any reader
    // that inspects a bounded prefix (a 600 KB read window, `head -c`, a capped file-read tool)
    // never reaches the usage row and reports ZERO ROWS — which is indistinguishable from "this
    // session has no data" and is exactly how this corpus reads as empty. This fixture puts a
    // ~700 KB first line ahead of the usage row, so a non-streaming implementation fails here.
    const hugeSystemPrompt = {
      type: 'system',
      timestamp: '2026-09-18T06:31:00.000Z',
      content: 'x'.repeat(700_000),
    };
    const filePath = await writeTranscript('su-a', 'session-a', [hugeSystemPrompt, usageEntry()]);

    const outcome = await measureTranscriptFile(filePath, { root });

    expect(outcome).toHaveProperty('sample');
    const { sample } = outcome as { sample: { totalPromptTokens: number; bytesBeforeSample: number } };
    expect(sample.totalPromptTokens).toBe(232_413);
    // Positive control for the claim above: the sample really did sit past a 600 KB window, so
    // a passing assertion here cannot be explained by the fixture having been small all along.
    expect(sample.bytesBeforeSample).toBeGreaterThan(600_000);
  });

  it('reports the full sample shape from the first qualifying row', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'user', timestamp: '2026-09-18T06:30:00.000Z' },
      usageEntry(),
      usageEntry({ timestamp: '2026-09-18T07:00:00.000Z' }),
    ]);

    const outcome = await measureTranscriptFile(filePath, { root });
    const { sample } = outcome as { sample: Record<string, unknown> };

    expect(sample).toMatchObject({
      ownerId: 'su-a',
      sessionId: 'session-a',
      day: '2026-09-18',
      model: 'claude-opus-5',
      entrypoint: 'cli',
      cliVersion: '2.1.0',
      inputTokens: 2,
      cacheCreationTokens: 128_745,
      cacheReadTokens: 103_666,
      totalPromptTokens: 232_413,
      // The FIRST usage row, not the last: line 2 of the file.
      lineNumber: 2,
    });
  });

  it('skips past small usage rows to the real launch turn', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'assistant', timestamp: '2026-09-18T06:29:00.000Z', message: { usage: { input_tokens: 40 } } },
      usageEntry(),
    ]);
    const outcome = await measureTranscriptFile(filePath, { root });
    expect((outcome as { sample: { totalPromptTokens: number } }).sample.totalPromptTokens).toBe(
      232_413,
    );
  });

  it('tolerates blank and malformed lines without aborting the scan', async () => {
    const dir = join(root, 'su-a', 'projects', '-repo');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'session-a.jsonl');
    await writeFile(filePath, `\n{not json\n\n${JSON.stringify(usageEntry())}\n`, 'utf8');

    const outcome = await measureTranscriptFile(filePath, { root });
    expect(outcome).toHaveProperty('sample');
  });
});

describe('measureTranscriptFile — typed skips, never silent drops', () => {
  it('reports no-usage-row for a transcript with no usage at all', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'user', timestamp: '2026-09-18T06:30:00.000Z' },
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({
      skip: { filePath, reason: 'no-usage-row' },
    });
  });

  it('reports all-below-threshold when every usage row is under the floor', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'assistant', timestamp: '2026-09-18T06:30:00.000Z', message: { usage: {
        input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      } } },
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({
      skip: { filePath, reason: 'all-below-threshold' },
    });
  });

  it('does not classify incomplete small counts as proven below the launch threshold', async () => {
    const filePath = await writeTranscript('su-incomplete', 'session-incomplete', [
      { type: 'assistant', timestamp: '2026-09-18T06:30:00.000Z', message: { usage: { input_tokens: 40 } } },
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({ skip: { filePath, reason: 'incomplete-usage' } });
  });

  it('reports sidechain-only when the only large turns are sub-agent turns', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      usageEntry({ isSidechain: true }),
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({
      skip: { filePath, reason: 'sidechain-only' },
    });
    // ...and measures it when sidechains are explicitly requested.
    const included = await measureTranscriptFile(filePath, { root, includeSidechains: true });
    expect(included).toHaveProperty('sample');
  });

  it('reports undatable rather than inventing a day', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      usageEntry({ timestamp: 'whenever' }),
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toMatchObject({
      skip: { reason: 'undatable' },
    });
  });

  it('reports unreadable for a file that does not exist', async () => {
    const filePath = join(root, 'su-a', 'projects', '-repo', 'missing.jsonl');
    expect(await measureTranscriptFile(filePath, { root })).toMatchObject({
      skip: { reason: 'unreadable' },
    });
  });

  it('applies day, model and owner filters as filtered-out skips', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [usageEntry()]);
    expect(await measureTranscriptFile(filePath, { root, since: '2026-09-19' })).toMatchObject({
      skip: { reason: 'filtered-out' },
    });
    expect(await measureTranscriptFile(filePath, { root, until: '2026-09-17' })).toMatchObject({
      skip: { reason: 'filtered-out' },
    });
    expect(
      await measureTranscriptFile(filePath, { root, modelContains: 'sonnet' }),
    ).toMatchObject({ skip: { reason: 'filtered-out' } });
    expect(await measureTranscriptFile(filePath, { root, ownerPrefix: 'role-' })).toMatchObject({
      skip: { reason: 'filtered-out' },
    });
    // Inclusive bounds on both ends.
    expect(
      await measureTranscriptFile(filePath, { root, since: '2026-09-18', until: '2026-09-18' }),
    ).toHaveProperty('sample');
  });
});

describe('collectTranscriptFiles', () => {
  it('finds transcripts nested under owner/projects/<project>', async () => {
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    await writeTranscript('role-b', 'session-b', [usageEntry()], '-other');
    await writeFile(join(root, 'not-a-transcript.txt'), 'ignored', 'utf8');

    const files = await collectTranscriptFiles(root);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('does not follow directory symlinks', async () => {
    // The repo guide's `find -L` incident: a symlink DAG under this tree ran 32h and consumed
    // 1.86 TB of swap. A transcript tree has no legitimate need to traverse a link, so a link
    // that would double the corpus must contribute nothing.
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    await symlink(join(root, 'su-a'), join(root, 'su-a-link'), 'dir');

    const files = await collectTranscriptFiles(root);
    expect(files).toHaveLength(1);
  });

  it('respects maxDepth', async () => {
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    // owner(1)/projects(2)/-repo(3)/file — depth 2 stops before the file's directory.
    expect(await collectTranscriptFiles(root, 2)).toHaveLength(0);
    expect(await collectTranscriptFiles(root, 3)).toHaveLength(1);
  });

  it('returns an empty list for a root that does not exist', async () => {
    expect(await collectTranscriptFiles(join(root, 'nope'))).toEqual([]);
  });
});

describe('ownerIdFromPath', () => {
  it('reads the first path segment below the root', () => {
    expect(ownerIdFromPath('/r', '/r/su-abc/projects/-repo/s.jsonl')).toBe('su-abc');
  });

  it('returns unknown for a path outside the root', () => {
    expect(ownerIdFromPath('/r', '/elsewhere/s.jsonl')).toBe('unknown');
  });
});

describe('scanLaunchTranscripts', () => {
  it('measures every transcript and censuses each skip by reason', async () => {
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    await writeTranscript('su-b', 'session-b', [
      usageEntry({ sessionId: 'session-b', timestamp: '2026-09-11T10:00:00.000Z' }),
    ]);
    await writeTranscript('su-c', 'session-c', [{ type: 'user' }]);
    await writeTranscript('su-d', 'session-d', [usageEntry({ isSidechain: true })]);

    const report = await scanLaunchTranscripts({ root });

    expect(report.filesScanned).toBe(4);
    expect(report.filesMeasured).toBe(2);
    expect(report.skippedByReason['no-usage-row']).toBe(1);
    expect(report.skippedByReason['sidechain-only']).toBe(1);
    expect(report.skipped).toHaveLength(2);
    // filesScanned === filesMeasured + skipped.length: no file is silently dropped.
    expect(report.filesMeasured + report.skipped.length).toBe(report.filesScanned);
    // Samples are ordered oldest-first by measured timestamp.
    expect(report.samples.map((s) => s.day)).toEqual(['2026-09-11', '2026-09-18']);
  });

  it('returns an honest empty report for an empty tree rather than failing', async () => {
    const report = await scanLaunchTranscripts({ root });
    expect(report.filesScanned).toBe(0);
    expect(report.samples).toEqual([]);
    expect(report.skipped).toEqual([]);
  });
});
