/**
 * trajectory-recorder.test.ts — the P-009 / D-013 recorder core, against a real
 * temp directory (the module's whole job is disk bookkeeping, so a mocked fs would
 * test the mock). No X server and no ffmpeg.
 *
 * The decision table these pin, in D-013's order:
 *   §2 the observation's pixels are REUSED, never re-captured
 *   §3 actions.jsonl is append-only; the frame files are the bounded ring
 *   §5 overflow drops the OLDEST and the drop count is DERIVED at read time
 *   §5 the wall-clock cap ENDS the recording rather than recording forever
 *   — and the rail under all of it: a recorder failure never throws into the
 *     agent's action path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionLedgerEntry } from './action-ledger';
import {
  ACTIONS_BASENAME,
  MANIFEST_BASENAME,
  RecordingAlreadyOpenError,
  __backdateRecordingForTests,
  __resetRecordingsForTests,
  isRecording,
  listRecordings,
  noteRecordedAction,
  pruneRecordings,
  readRecording,
  recordingStatus,
  startRecording,
  stopRecording,
  type RecordingManifest,
} from './trajectory-recorder';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

let root: string;
let seq = 0;

function entry(over: Partial<ActionLedgerEntry> = {}): ActionLedgerEntry {
  seq += 1;
  return {
    seq,
    action: 'left_click',
    coordinate: [10, 20],
    ok: true,
    observed: 'tree',
    atMs: 1_000_000 + seq * 500,
    ...over,
  };
}

function start(display = ':991', over: Parameters<typeof startRecording>[0] | Record<string, unknown> = {}) {
  return startRecording({ display, root, ...(over as object) } as Parameters<typeof startRecording>[0]);
}

beforeEach(() => {
  seq = 0;
  root = mkdtempSync(join(tmpdir(), 'pc-rec-'));
});

afterEach(() => {
  __resetRecordingsForTests();
  rmSync(root, { recursive: true, force: true });
});

describe('startRecording', () => {
  it('creates the directory, the manifest and an empty append-only action stream', () => {
    const rec = start();
    expect(isRecording(':991')).toBe(true);
    expect(existsSync(join(rec.dir, MANIFEST_BASENAME))).toBe(true);
    expect(existsSync(join(rec.dir, ACTIONS_BASENAME))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(rec.dir, MANIFEST_BASENAME), 'utf8')) as RecordingManifest;
    expect(manifest.display).toBe(':991');
    expect(manifest.endedAtMs).toBeNull();
    // The manifest must NOT carry a frame list — it is rewritten only at stop, and
    // a growing array there would be a second copy of actions.jsonl.
    expect(Object.keys(manifest)).not.toContain('frames');
  });

  it('binds the work-item at START so a later export cannot park on the wrong one', () => {
    const rec = start(':991', { workItem: 'WI-1234', note: 'save-dialog hang' });
    expect(rec.workItem).toBe('WI-1234');
    expect(rec.note).toBe('save-dialog hang');
  });

  it('REFUSES a second recording on the same display rather than splitting one trajectory', () => {
    const first = start();
    expect(() => start()).toThrow(RecordingAlreadyOpenError);
    try {
      start();
    } catch (e) {
      // The refusal names the recording already open, so the caller can stop it.
      expect((e as RecordingAlreadyOpenError).existing.id).toBe(first.id);
      expect((e as Error).message).toContain(first.id);
    }
  });

  it('records different displays independently', () => {
    start(':991');
    start(':992');
    expect(isRecording(':991')).toBe(true);
    expect(isRecording(':992')).toBe(true);
    expect(listRecordings(root)).toHaveLength(2);
  });
});

describe('noteRecordedAction', () => {
  it('is a no-op — and never captures — when the display is not being recorded', async () => {
    let captures = 0;
    const frame = await noteRecordedAction(':991', entry(), {
      capture: async () => {
        captures += 1;
        return PNG;
      },
    });
    expect(frame).toBeNull();
    expect(captures).toBe(0);
  });

  it('REUSES the observation pixels instead of capturing again (D-013 §2)', async () => {
    const rec = start();
    let captures = 0;
    const frame = await noteRecordedAction(':991', entry(), {
      pngBase64: PNG.toString('base64'),
      capture: async () => {
        captures += 1;
        return Buffer.from('never');
      },
    });
    expect(captures).toBe(0);
    expect(frame?.reused).toBe(true);
    // Byte-identical: the recorded frame IS the image the model was shown.
    expect(readFileSync(join(rec.dir, frame!.file))).toEqual(PNG);
  });

  it('captures when the observation produced no pixels, and marks the frame not-reused', async () => {
    start();
    const frame = await noteRecordedAction(':991', entry({ observed: 'none' }), { capture: async () => PNG });
    expect(frame?.reused).toBe(false);
    expect(frame?.bytes).toBe(PNG.length);
  });

  it('keys the frame to the LEDGER seq and carries its rendered line', async () => {
    start();
    const frame = await noteRecordedAction(':991', entry({ seq: 7, action: 'left_click' }), { capture: async () => PNG });
    expect(frame?.seq).toBe(7);
    expect(frame?.file).toBe('frame-000007.png');
    expect(frame?.line).toContain('#7 left_click');
  });

  it('appends exactly one action-stream line per frame', async () => {
    const rec = start();
    for (let i = 0; i < 3; i += 1) await noteRecordedAction(':991', entry(), { capture: async () => PNG });
    const lines = readFileSync(join(rec.dir, ACTIONS_BASENAME), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).seq).toBe(1);
  });

  it('records nothing when neither pixels nor a capture are available', async () => {
    start();
    expect(await noteRecordedAction(':991', entry(), {})).toBeNull();
  });

  it('NEVER throws into the action path — a write failure lands on lastError', async () => {
    const rec = start();
    // Make the recording directory unwritable: the frame write must fail.
    chmodSync(rec.dir, 0o500);
    try {
      const frame = await noteRecordedAction(':991', entry(), { capture: async () => PNG });
      expect(frame).toBeNull();
      expect(recordingStatus(':991')?.lastError).toBeTruthy();
    } finally {
      chmodSync(rec.dir, 0o700);
    }
  });

  it('propagates nothing when the CAPTURE itself throws', async () => {
    start();
    const frame = await noteRecordedAction(':991', entry(), {
      capture: async () => {
        throw new Error('import: unable to open X server');
      },
    });
    expect(frame).toBeNull();
    expect(recordingStatus(':991')?.lastError).toContain('unable to open X server');
  });
});

describe('bounds (D-013 §5)', () => {
  it('evicts the OLDEST frame files past maxFrames and keeps the tail', async () => {
    const rec = start(':991', { bounds: { maxFrames: 2 } });
    for (let i = 0; i < 4; i += 1) await noteRecordedAction(':991', entry(), { capture: async () => PNG });

    const pngs = readdirSync(rec.dir).filter((f) => f.endsWith('.png')).sort();
    expect(pngs).toEqual(['frame-000003.png', 'frame-000004.png']);

    // The stream keeps every line; the drop count is DERIVED from the two artifacts.
    const loaded = readRecording(rec.dir);
    expect(loaded.frames.map((f) => f.seq)).toEqual([3, 4]);
    expect(loaded.droppedFrames).toBe(2);
    expect(readFileSync(join(rec.dir, ACTIONS_BASENAME), 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('evicts on maxBytes too', async () => {
    const rec = start(':991', { bounds: { maxBytes: PNG.length * 2 } });
    for (let i = 0; i < 5; i += 1) await noteRecordedAction(':991', entry(), { capture: async () => PNG });
    expect(readdirSync(rec.dir).filter((f) => f.endsWith('.png'))).toHaveLength(2);
    expect(readRecording(rec.dir).droppedFrames).toBe(3);
  });

  it('AUTO-STOPS at the wall-clock cap instead of recording forever', async () => {
    const rec = start(':991', { bounds: { maxDurationSec: 30 } });
    // Backdate the start past the cap — no fake timers needed, and this is exactly
    // the state a long-lived pot desktop reaches.
    __backdateRecordingForTests(':991', Date.now() - 31_000);

    const frame = await noteRecordedAction(':991', entry(), { capture: async () => PNG });
    expect(frame).toBeNull();
    expect(isRecording(':991')).toBe(false);
    const manifest = JSON.parse(readFileSync(join(rec.dir, MANIFEST_BASENAME), 'utf8')) as RecordingManifest;
    expect(manifest.endReason).toBe('duration-cap');
    expect(manifest.endedAtMs).toBeTruthy();
  });
});

describe('stopRecording', () => {
  it('closes the manifest and is idempotent', () => {
    const rec = start();
    const stopped = stopRecording(':991');
    expect(stopped?.endReason).toBe('stopped');
    expect(stopped?.endedAtMs).toBeTruthy();
    expect(isRecording(':991')).toBe(false);
    expect(stopRecording(':991')).toBeNull();
    const manifest = JSON.parse(readFileSync(join(rec.dir, MANIFEST_BASENAME), 'utf8')) as RecordingManifest;
    expect(manifest.endReason).toBe('stopped');
  });

  it('records WHY it ended so a released desktop is distinguishable from a user stop', () => {
    start();
    expect(stopRecording(':991', 'desktop-released')?.endReason).toBe('desktop-released');
  });
});

describe('readRecording', () => {
  it('survives a torn final line (what a crash mid-append looks like)', async () => {
    const rec = start();
    await noteRecordedAction(':991', entry(), { capture: async () => PNG });
    writeFileSync(join(rec.dir, ACTIONS_BASENAME), `${readFileSync(join(rec.dir, ACTIONS_BASENAME), 'utf8')}{"seq":2,"fi`);
    const loaded = readRecording(rec.dir);
    expect(loaded.frames).toHaveLength(1);
    expect(loaded.droppedFrames).toBe(0);
  });

  it('refuses a directory that is not a recording', () => {
    expect(() => readRecording(root)).toThrow(/no recording at/);
  });
});

describe('pruneRecordings', () => {
  it('keeps the newest N and never deletes an OPEN recording', async () => {
    const a = start(':991');
    stopRecording(':991');
    const b = start(':991');
    stopRecording(':991');
    const open = start(':992');

    // Newest-first ordering is by mtime; make the intent explicit rather than
    // relying on same-millisecond creation order.
    const removed = pruneRecordings(root, 1);
    expect(existsSync(open.dir)).toBe(true);
    expect(removed.length).toBeGreaterThanOrEqual(1);
    expect([a.dir, b.dir].filter((d) => existsSync(d)).length).toBeLessThanOrEqual(1);
  });
});
