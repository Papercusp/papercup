/**
 * WI-10004533 — the result-door spill write must not block the request worker's main thread.
 *
 * The synchronous mkdirSync + writeFileSync in writeScratchReference sat in D-state under
 * ext4/jbd2 contention long enough for the event-loop sentinel to SIGKILL the operator with
 * every in-flight MCP call. Request handlers now use applyResultDoorAsync: the spill is
 * written with fs.promises and awaited before the result is returned, so the cursor is
 * still valid when the client sees it, but the event loop is free while the disk is slow.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
import { CHARS_PER_TOKEN_ESTIMATE } from './context-doors';
import {
  applyResultDoor,
  applyResultDoorAsync,
  beginResultDoorAggregate,
  resetResultDoorAggregatesForTests,
  RESULT_DOOR_TOKENS,
  type DoorableResult,
} from './result-door';
import { _resetScratchUsageForTests, _setScratchUsageForTests, refreshScratchUsage, WORKSPACE_QUOTA_BYTES, writeWithScratchQuota } from './scratch-gc';
import { parseScratchReference, writeScratchReference } from './scratch-reference';
import type { ScratchWriteTimings } from './scratch-gc';

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const OPTS = { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID } as const;

let sandbox: string;
let prevScratchRoot: string | undefined;
let prevKillSwitch: string | undefined;

function oversized() {
  const text = Array.from({ length: Math.ceil((BUDGET_CHARS * 3) / 40) }, (_, i) => `line ${i} of a very long tool result`)
    .join('\n');
  return { content: [{ type: 'text' as const, text }] };
}

function spillDir(): string {
  return join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'plans:get', RUN_ID);
}

function spillFiles(): string[] {
  return existsSync(spillDir()) ? readdirSync(spillDir()) : [];
}

beforeEach(() => {
  resetResultDoorAggregatesForTests();
  _resetScratchUsageForTests();
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-deferred-spill-test-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  prevKillSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
  delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  if (prevKillSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  else process.env.PAPERCUSP_RESULT_DOOR_OFF = prevKillSwitch;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('result-door deferred spill (WI-10004533)', () => {
  it.each(['text', 'media'])('reports a persisted %s spill phase without allowing observer failure to lose the original payload', async (kind) => {
    const observed = vi.fn((_timings: ScratchWriteTimings) => { throw new Error('diagnostic observer failed'); });
    const original = kind === 'text' ? oversized().content[0].text : 'A'.repeat(BUDGET_CHARS * 3);
    const input = kind === 'text' ? { content: [{ type: 'text', text: original }] }
      : { content: [{ type: 'image', mimeType: 'image/png', data: original }] };
    const result = await applyResultDoorAsync<DoorableResult>(input, { ...OPTS, onScratchWriteTiming: observed });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0][0]).toEqual({
      quotaWaitMs: expect.any(Number), refreshWaitMs: expect.any(Number),
      quotaRecoveryMs: expect.any(Number), writeMs: expect.any(Number), totalMs: expect.any(Number),
    });
    const path = (result._meta?.resultDoor as { spillPath?: string })?.spillPath;
    expect(parseScratchReference(readFileSync(path!))!.payload.toString()).toContain(original);
  });
  it('with a collector, the synchronous door performs NO filesystem write — the spill lands only when awaited', async () => {
    const deferred: Promise<void>[] = [];
    const out = applyResultDoor(oversized(), { ...OPTS, deferredScratchWrites: deferred });

    // The door already produced its bounded, spill-referencing result...
    expect(JSON.stringify(out)).toContain(RUN_ID);
    // ...but nothing was written on the synchronous path: the write is queued, not done.
    expect(deferred).toHaveLength(1);
    expect(spillFiles()).toHaveLength(0);

    await Promise.all(deferred);
    const files = spillFiles();
    expect(files).toHaveLength(1);
    const ref = parseScratchReference(readFileSync(join(spillDir(), files[0])));
    expect(ref).not.toBeNull();
    expect(ref!.payload.toString('utf8')).toContain('line 0 of a very long tool result');
  });

  it('applyResultDoorAsync resolves only after the spill exists, with the same result shape as the sync door', async () => {
    const asyncOut = await applyResultDoorAsync(oversized(), OPTS);
    const files = spillFiles();
    expect(files).toHaveLength(1);
    const ref = parseScratchReference(readFileSync(join(spillDir(), files[0])));
    expect(ref).not.toBeNull();
    // The cursor the client receives names the file that is now on disk.
    expect(JSON.stringify(asyncOut)).toContain(files[0]);

    resetResultDoorAggregatesForTests();
    const syncOut = applyResultDoor(oversized(), OPTS);
    expect(Object.keys(asyncOut).sort()).toEqual(Object.keys(syncOut).sort());
    expect(asyncOut.content.length).toBe(syncOut.content.length);
  });

  it('a result that fits writes nothing and resolves unchanged', async () => {
    const small = { content: [{ type: 'text' as const, text: 'short result' }] };
    const out = await applyResultDoorAsync(small, OPTS);
    expect(out.content).toEqual(small.content);
    expect(spillFiles()).toHaveLength(0);
  });

  it('a failed deferred write never yields a dangling cursor, and never surfaces as an unhandled rejection', async () => {
    // Scratch root UNDER A REGULAR FILE: every mkdir fails with ENOTDIR, async and sync alike.
    const blocker = join(sandbox, 'not-a-dir');
    writeFileSync(blocker, 'x');
    process.env.PAPERCUSP_SCRATCH_ROOT = join(blocker, 'scratch');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      vi.mocked(mkdirSync).mockClear();
      vi.mocked(writeFileSync).mockClear();
      const out = await applyResultDoorAsync(oversized(), OPTS);
      expect(vi.mocked(mkdirSync)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
      // Still bounded (the cap applies even when the spill cannot be written, WI-36047)...
      expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(oversized()).length);
      // ...and it carries the honest spill-failure shape: no cursor/path, flagged failed.
      // (`_meta.resultDoor.spillError` legitimately names the failing path for operators;
      // the MODEL-FACING content must not advertise a file that is not there.)
      const meta = (out as { _meta?: { resultDoor?: { spillPath?: unknown; spillFailed?: unknown } } })._meta
        ?.resultDoor;
      expect(meta?.spillFailed).toBe(true);
      expect(meta?.spillPath ?? null).toBeNull();
      expect(JSON.stringify(out.content)).not.toContain(blocker);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps a no-code spill failure diagnosable in the model-facing cursor without exposing the scratch path', () => {
    const scratchRunDir = spillDir();
    const failure = new Error(`writer rejected directory '${scratchRunDir}'`);
    failure.name = 'ScratchWriteError';
    const out = applyResultDoor(oversized(), {
      ...OPTS,
      scratchWriteFailure: { error: failure },
    });
    const text = (out.content.find((item) => item.type === 'text') as { text: string }).text;
    const body = JSON.parse(text) as { _projection?: { cursor?: Record<string, unknown>; next?: string } };

    expect(body._projection?.cursor).toMatchObject({
      kind: 'unavailable',
      reason: 'spill-write-failed',
      errorDetail: 'ScratchWriteError: writer rejected directory \'<scratch path>\'',
    });
    expect(body._projection?.next).toContain('ScratchWriteError: writer rejected directory');
    expect(body._projection?.next).not.toContain(scratchRunDir);
    expect(text).not.toContain(scratchRunDir);
  });

  it('recovers quota pressure before returning a readable asynchronous spill cursor', async () => {
    const old = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'history', 'old');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'data'), '');
    truncateSync(join(old, 'data'), WORKSPACE_QUOTA_BYTES);
    const past = (Date.now() - 10_000) / 1000;
    utimesSync(old, past, past);
    await refreshScratchUsage('ws-1');
    const out = await applyResultDoorAsync(oversized(), OPTS);
    expect(existsSync(old)).toBe(false);
    const files = spillFiles();
    expect(files).toHaveLength(1);
    expect(JSON.stringify(out)).toContain(files[0]);
    expect(parseScratchReference(readFileSync(join(spillDir(), files[0])))!.payload.toString()).toContain('line 0');
  });

  it('returns a readable spill after stale-cache recovery overlaps an active reservation', async () => {
    const writerDir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'writers', RUN_ID);
    mkdirSync(writerDir, { recursive: true });
    _setScratchUsageForTests('ws-1', 0);
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const heldPath = join(writerDir, 'held');
    const held = writeWithScratchQuota({ workspaceId: 'ws-1', filePath: heldPath, bytes: 512 }, async () => {
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
      await writeFile(heldPath, Buffer.alloc(512));
    });
    await began;
    _setScratchUsageForTests('ws-1', 5_400_804_525);
    try {
      const out = await applyResultDoorAsync(oversized(), OPTS);
      const files = spillFiles();
      expect(files).toHaveLength(1);
      expect(JSON.stringify(out)).toContain(files[0]);
      expect(JSON.stringify(out)).not.toContain('SCRATCH_QUOTA_EXCEEDED');
      expect(parseScratchReference(readFileSync(join(spillDir(), files[0])))!.payload.toString()).toContain('line 0');
    } finally {
      finish();
      await held;
    }
    await refreshScratchUsage('ws-1');
  });

  it('reports the quota cause without a dangling cursor when no FIFO run can be reclaimed', async () => {
    const root = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'unmanaged'), '');
    truncateSync(join(root, 'unmanaged'), WORKSPACE_QUOTA_BYTES);
    await refreshScratchUsage('ws-1');
    const out = await applyResultDoorAsync(oversized(), OPTS);
    const meta = (out as { _meta?: { resultDoor?: { spillFailed?: boolean; spillErrorCode?: string; spillError?: string; spillPath?: string } } })._meta?.resultDoor;
    expect(meta?.spillFailed).toBe(true);
    expect(meta?.spillErrorCode).toBe('SCRATCH_QUOTA_EXCEEDED');
    expect(meta?.spillError).toMatch(/^scratch reservation: workspace ws-1 used \d+ \+ \d+ > quota 5368709120$/);
    expect(meta?.spillPath ?? null).toBeNull();
    expect(JSON.stringify(out.content)).toContain('SCRATCH_QUOTA_EXCEEDED');
    expect(spillFiles()).toHaveLength(0);

    // Non-text overflow uses the hard-envelope branch; its error must retain the same cause.
    const hard = await applyResultDoorAsync({ content: [{ type: 'image' as const,
      mimeType: 'image/png', data: 'A'.repeat(BUDGET_CHARS * 3) }] }, OPTS);
    expect(JSON.stringify(hard.content)).toContain('SCRATCH_QUOTA_EXCEEDED');
    expect(JSON.stringify(hard.content)).toContain('output_spill_failed');
    expect(spillFiles()).toHaveLength(0);
  });

  it('writeScratchReference with deferredWrites reserves and writes through the asynchronous path', async () => {
    const filePath = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'x:y', RUN_ID, 'ref.spill');
    const deferred: Promise<void>[] = [];
    const manifest = writeScratchReference({
      filePath,
      payload: 'hello deferred',
      workspaceId: 'ws-1',
      mediaType: 'text/plain',
      deferredWrites: deferred,
    });
    expect(manifest.byteCount).toBe(Buffer.byteLength('hello deferred'));
    expect(existsSync(filePath)).toBe(false);
    await Promise.all(deferred);
    const ref = parseScratchReference(readFileSync(filePath));
    expect(ref!.payload.toString('utf8')).toBe('hello deferred');
    expect(ref!.manifest.sha256).toBe(manifest.sha256);
  });

  describe('read-surface spill failures', () => {
    function breakScratchRoot(): void {
      const blocker = join(sandbox, 'scratch-is-a-file');
      writeFileSync(blocker, 'x');
      process.env.PAPERCUSP_SCRATCH_ROOT = join(blocker, 'scratch');
    }

    it.each(['coord:feed', 'work_items:list', 'work_items:get'] as const)(
      '%s returns a bounded result without a dangling cursor when the shared writer fails',
      async (toolName) => {
        breakScratchRoot();
        const rows = Array.from({ length: 12 }, (_, index) => ({
          id: `WI-${index}`,
          summary: 's'.repeat(900),
        }));
        const body = toolName === 'work_items:list'
          ? rows
          : toolName === 'coord:feed'
            ? { messages: rows }
            : {
                ok: true,
                results: rows.map((row) => ({ id: row.id, ok: true, workItem: row })),
                counts: { ok: rows.length, failed: 0 },
              };
        const original = JSON.stringify(body);
        expect(original.length).toBeGreaterThan(BUDGET_CHARS);

        const out = await applyResultDoorAsync(
          { content: [{ type: 'text' as const, text: original }] },
          { ...OPTS, toolName },
        );
        const resultText = (out.content.find((item) => item.type === 'text') as { text: string }).text;
        const meta = (out as {
          _meta?: {
            resultDoor?: {
              recoveryCursor?: Record<string, unknown>;
              [key: string]: unknown;
            };
          };
        })._meta?.resultDoor;

        expect(resultText.length).toBeLessThan(original.length);
        expect(meta?.recoveryCursor).toMatchObject({ kind: 'unavailable', reason: 'spill-write-failed' });
        expect(resultText).not.toContain('papercusp://scratch');
        expect(meta).toMatchObject({ spillFailed: true, spillPath: null, spillUri: null, spillErrorCode: 'ENOTDIR' });
      },
    );

    it('coord:feed reports the failed hard-overflow envelope with accounting when aggregate spill cannot persist', async () => {
      breakScratchRoot();
      const aggregateScope = beginResultDoorAggregate({ sessionKey: 'read-surface-test', outputGroupId: 'turn-1' });
      const fill = { content: [{ type: 'text' as const, text: 'f'.repeat(BUDGET_CHARS) }] };
      await applyResultDoorAsync(fill, { ...OPTS, toolName: 'coord:feed', aggregateScope });
      await applyResultDoorAsync(fill, { ...OPTS, toolName: 'coord:feed', aggregateScope });

      const original = JSON.stringify({ messages: 'm'.repeat(BUDGET_CHARS) });
      const out = await applyResultDoorAsync(
        { content: [{ type: 'text' as const, text: original }] },
        { ...OPTS, toolName: 'coord:feed', aggregateScope },
      );
      const envelope = JSON.parse((out.content[0] as { text: string }).text) as {
        state?: string;
        error?: { code?: string; message?: string; retryable?: boolean };
      };
      const meta = (out as { _meta?: { resultDoor?: Record<string, unknown> } })._meta?.resultDoor;

      expect(envelope).toMatchObject({ state: 'error', error: { code: 'output_spill_failed', retryable: true } });
      expect(envelope.error?.message).toContain('ENOTDIR');
      expect(envelope.error?.message).toContain('not a directory');
      expect(envelope.error?.message).toContain('<scratch path>');
      expect(envelope.error?.message).not.toContain(sandbox);
      expect(meta).toMatchObject({
        spillFailed: true,
        spillPath: null,
        spillUri: null,
        spillErrorCode: 'ENOTDIR',
        originalBytes: Buffer.byteLength(original),
      });
      expect(JSON.stringify(out.content)).not.toContain('papercusp://scratch');
    });
  });
});
