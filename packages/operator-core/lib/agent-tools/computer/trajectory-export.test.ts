/**
 * trajectory-export.test.ts — the P-009 export (D-013 §7). The command builders are
 * pure, so they are tested directly; `exportRecording` runs through an injected exec
 * and never spawns ffmpeg here (a live encode is covered by the gated live suite).
 *
 * The properties worth pinning are the ones a passing encode would NOT reveal:
 * a wrong frame duration still produces a valid video, and a single-pass GIF still
 * produces a valid GIF — both are silently wrong, not broken.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONCAT_BASENAME,
  LAST_FRAME_SEC,
  MAX_FRAME_SEC,
  MIN_FRAME_SEC,
  PALETTE_BASENAME,
  buildConcatScript,
  clampFrameSeconds,
  exportCommands,
  exportDurationSeconds,
  exportPointerLine,
  exportRecording,
  gifCommand,
  gifPaletteCommand,
  webmCommand,
  type ExportExec,
} from './trajectory-export';
import type { RecordedFrame } from './trajectory-recorder';
import {
  __resetRecordingsForTests,
  noteRecordedAction,
  startRecording,
  stopRecording,
} from './trajectory-recorder';
import type { ActionLedgerEntry } from './action-ledger';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 3)]);

function frame(seq: number, atMs: number): RecordedFrame {
  return { seq, file: `frame-${String(seq).padStart(6, '0')}.png`, bytes: 100, atMs, line: `#${seq} left_click ok`, reused: false };
}

describe('clampFrameSeconds', () => {
  it('clamps a long model think down and a fast step up (D-013 §7)', () => {
    expect(clampFrameSeconds(240)).toBe(MAX_FRAME_SEC);
    expect(clampFrameSeconds(0.01)).toBe(MIN_FRAME_SEC);
    expect(clampFrameSeconds(1.25)).toBe(1.25);
  });

  it('treats a non-positive or non-finite gap as the minimum, never as zero', () => {
    // Two ledger entries can share a millisecond; a 0s frame would be dropped
    // entirely by the encoder, silently losing a step from the trajectory.
    expect(clampFrameSeconds(0)).toBe(MIN_FRAME_SEC);
    expect(clampFrameSeconds(-5)).toBe(MIN_FRAME_SEC);
    expect(clampFrameSeconds(Number.NaN)).toBe(MIN_FRAME_SEC);
  });
});

describe('buildConcatScript', () => {
  it('gives each frame the REAL gap to its successor', () => {
    const script = buildConcatScript([frame(1, 0), frame(2, 1_500), frame(3, 2_000)]);
    expect(script).toContain("file 'frame-000001.png'\nduration 1.500");
    expect(script).toContain("file 'frame-000002.png'\nduration 0.500");
  });

  it('REPEATS the last file so its duration is not discarded by the demuxer', () => {
    const lines = buildConcatScript([frame(1, 0), frame(2, 500)]).trim().split('\n');
    expect(lines[0]).toBe('ffconcat version 1.0');
    expect(lines[lines.length - 1]).toBe("file 'frame-000002.png'");
    // …and the repeat is a bare `file` with no duration after it.
    expect(lines.filter((l) => l === "file 'frame-000002.png'")).toHaveLength(2);
  });

  it('holds the final frame for LAST_FRAME_SEC (it has no successor to measure)', () => {
    expect(buildConcatScript([frame(1, 0)])).toContain(`duration ${LAST_FRAME_SEC.toFixed(3)}`);
  });

  it('refuses zero frames rather than emitting an empty script', () => {
    expect(() => buildConcatScript([])).toThrow(/zero frames/);
  });
});

describe('exportDurationSeconds', () => {
  it('sums the same clamped durations the script uses', () => {
    // 1.5s gap + a 600s think clamped to 3s + the last-frame hold.
    const frames = [frame(1, 0), frame(2, 1_500), frame(3, 601_500)];
    expect(exportDurationSeconds(frames)).toBeCloseTo(1.5 + MAX_FRAME_SEC + LAST_FRAME_SEC, 5);
  });
});

describe('command builders', () => {
  it('feeds ffmpeg the concat demuxer with -safe 0 and variable frame timing', () => {
    const cmd = webmCommand('trajectory.webm');
    expect(cmd.args).toEqual(expect.arrayContaining(['-f', 'concat', '-safe', '0', '-i', CONCAT_BASENAME]));
    expect(cmd.args).toEqual(expect.arrayContaining(['-fps_mode', 'vfr']));
    expect(cmd.args).toEqual(expect.arrayContaining(['-c:v', 'libvpx-vp9']));
    // yuv420p demands even dimensions; an odd-height display would fail the encode.
    expect(cmd.args.join(' ')).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    expect(cmd.args[cmd.args.length - 1]).toBe('trajectory.webm');
  });

  it('renders GIF in TWO passes so ffmpeg never buffers the whole clip in RAM', () => {
    const cmds = exportCommands('gif', 'trajectory.gif');
    expect(cmds).toHaveLength(2);
    expect(cmds[0]!.args.join(' ')).toContain('palettegen');
    expect(cmds[0]!.args[cmds[0]!.args.length - 1]).toBe(PALETTE_BASENAME);
    expect(cmds[1]!.args.join(' ')).toContain('paletteuse');
    // The second pass CONSUMES the palette the first wrote.
    expect(cmds[1]!.args).toEqual(expect.arrayContaining(['-i', PALETTE_BASENAME]));
    expect(cmds[1]!.args.join(' ')).not.toContain('palettegen');
    expect(gifPaletteCommand().bin).toBe('ffmpeg');
    expect(gifCommand('x.gif').args).toEqual(expect.arrayContaining(['-loop', '0']));
  });

  it('webm is a single pass', () => {
    expect(exportCommands('webm', 'trajectory.webm')).toHaveLength(1);
  });
});

describe('exportRecording', () => {
  let root: string;
  let dir: string;
  let calls: Array<{ bin: string; args: string[]; cwd: string }>;
  let exec: ExportExec;

  function entry(seq: number, atMs: number): ActionLedgerEntry {
    return { seq, action: 'left_click', ok: true, observed: 'tree', atMs };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'pc-exp-'));
    const rec = startRecording({ display: ':993', root, workItem: 'WI-777' });
    dir = rec.dir;
    await noteRecordedAction(':993', entry(1, 1_000), { capture: async () => PNG });
    await noteRecordedAction(':993', entry(2, 2_200), { capture: async () => PNG });
    stopRecording(':993');
    calls = [];
    exec = async (bin, args, opts) => {
      calls.push({ bin, args, cwd: opts.cwd });
      // Stand in for ffmpeg: produce the output file it was asked for.
      writeFileSync(join(opts.cwd, args[args.length - 1]!), Buffer.alloc(2048, 9));
      return { status: 0, stderr: '' };
    };
  });

  afterEach(() => {
    __resetRecordingsForTests();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the concat script into the recording directory and runs ffmpeg there', async () => {
    const result = await exportRecording(dir, { format: 'webm', exec });
    expect(existsSync(join(dir, CONCAT_BASENAME))).toBe(true);
    expect(readFileSync(join(dir, CONCAT_BASENAME), 'utf8')).toContain("file 'frame-000001.png'");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe(dir);
    expect(result.path).toBe(join(dir, 'trajectory.webm'));
    expect(result.frames).toBe(2);
    expect(result.droppedFrames).toBe(0);
    expect(result.bytes).toBe(2048);
    // 1.2s real gap + the last-frame hold.
    expect(result.playbackSec).toBeCloseTo(1.2 + LAST_FRAME_SEC, 2);
  });

  it('runs BOTH gif passes in order', async () => {
    await exportRecording(dir, { format: 'gif', exec });
    expect(calls.map((c) => c.args.join(' ').includes('palettegen'))).toEqual([true, false]);
  });

  it('REFUSES an empty recording instead of producing a blank video', async () => {
    const empty = startRecording({ display: ':994', root });
    stopRecording(':994');
    await expect(exportRecording(empty.dir, { format: 'webm', exec })).rejects.toThrow(/no frames on disk/);
  });

  it('surfaces ffmpeg stderr rather than reporting a success it did not get', async () => {
    const failing: ExportExec = async () => ({ status: 1, stderr: 'Unknown encoder libvpx-vp9' });
    await expect(exportRecording(dir, { format: 'webm', exec: failing })).rejects.toThrow(/Unknown encoder libvpx-vp9/);
  });

  it('refuses a ffmpeg that exits 0 without writing the file', async () => {
    const lying: ExportExec = async () => ({ status: 0, stderr: '' });
    await expect(exportRecording(dir, { format: 'webm', exec: lying })).rejects.toThrow(/wrote no trajectory.webm/);
  });

  it('reports frames the bounds evicted, so a short export is never read as a short session', async () => {
    const bounded = startRecording({ display: ':995', root, bounds: { maxFrames: 1 } });
    await noteRecordedAction(':995', entry(1, 1_000), { capture: async () => PNG });
    await noteRecordedAction(':995', entry(2, 2_000), { capture: async () => PNG });
    stopRecording(':995');
    const result = await exportRecording(bounded.dir, { format: 'webm', exec });
    expect(result.frames).toBe(1);
    expect(result.droppedFrames).toBe(1);
    expect(exportPointerLine(result)).toContain('evicted by the recording bounds');
  });
});

describe('exportPointerLine', () => {
  it('names the path, the counts and that the bytes stayed on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-ptr-'));
    try {
      const rec = startRecording({ display: ':996', root, workItem: 'WI-42' });
      await noteRecordedAction(':996', { seq: 1, action: 'key', keys: 'ctrl+s', ok: true, observed: 'none', atMs: 5 }, {
        capture: async () => PNG,
      });
      stopRecording(':996');
      const exec: ExportExec = async (_bin, args, opts) => {
        writeFileSync(join(opts.cwd, args[args.length - 1]!), Buffer.alloc(4096, 1));
        return { status: 0, stderr: '' };
      };
      const line = exportPointerLine(await exportRecording(rec.dir, { format: 'gif', exec }));
      expect(line).toContain(rec.id);
      expect(line).toContain(':996');
      expect(line).toContain('trajectory.gif');
      expect(line).toContain('1 action frame(s)');
      expect(line).toContain('4 KB');
      expect(line).toMatch(/never enters Postgres/);
    } finally {
      __resetRecordingsForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
