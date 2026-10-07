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
  resetResultDoorAggregatesForTests,
  RESULT_DOOR_TOKENS,
} from './result-door';
import { _resetScratchUsageForTests, refreshScratchUsage, WORKSPACE_QUOTA_BYTES } from './scratch-gc';
import { parseScratchReference, writeScratchReference } from './scratch-reference';

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

  it('reports the quota cause without a dangling cursor when no FIFO run can be reclaimed', async () => {
    const root = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'unmanaged'), '');
    truncateSync(join(root, 'unmanaged'), WORKSPACE_QUOTA_BYTES);
    await refreshScratchUsage('ws-1');
    const out = await applyResultDoorAsync(oversized(), OPTS);
    const meta = (out as { _meta?: { resultDoor?: { spillFailed?: boolean; spillErrorCode?: string; spillPath?: string } } })._meta?.resultDoor;
    expect(meta?.spillFailed).toBe(true);
    expect(meta?.spillErrorCode).toBe('SCRATCH_QUOTA_EXCEEDED');
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
});
