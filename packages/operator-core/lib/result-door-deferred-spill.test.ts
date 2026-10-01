/**
 * WI-10004533 — the result-door spill write must not block the request worker's main thread.
 *
 * The synchronous mkdirSync + writeFileSync in writeScratchReference sat in D-state under
 * ext4/jbd2 contention long enough for the event-loop sentinel to SIGKILL the operator with
 * every in-flight MCP call. Request handlers now use applyResultDoorAsync: the spill is
 * written with fs.promises and awaited before the result is returned, so the cursor is
 * still valid when the client sees it, but the event loop is free while the disk is slow.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN_ESTIMATE } from './context-doors';
import {
  applyResultDoor,
  applyResultDoorAsync,
  resetResultDoorAggregatesForTests,
  RESULT_DOOR_TOKENS,
} from './result-door';
import { _resetScratchUsageForTests } from './scratch-gc';
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
      const out = await applyResultDoorAsync(oversized(), OPTS);
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

  it('writeScratchReference with deferredWrites reserves synchronously but writes asynchronously', async () => {
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
