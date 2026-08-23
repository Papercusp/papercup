/**
 * trajectory-live.test.ts — OPT-IN live proof of P-009 (D-013): a REAL Xvfb desktop,
 * REAL `import` captures driven by REAL `xdotool` actions, and a REAL ffmpeg encode.
 * No seams.
 *
 * WHY THIS EXISTS BESIDE THE UNIT SUITE. Every property the unit tests pin can hold
 * while the feature is still useless, because the two things that can only fail live
 * are the two that matter: ffmpeg either accepts the concat script or it does not,
 * and the exported video either has the DURATION the timing model promised or the
 * clamping is wrong in a way no fake exec can reveal. So this asserts the encode
 * against `ffprobe`, not against our own arithmetic.
 *
 * GUARDED: runs ONLY when PAPERCUSP_COMPUTER_LIVE=1 and the X + ffmpeg tooling is
 * present, so a normal `test:affected` run SKIPS it. To run it on a box with X:
 *   PAPERCUSP_COMPUTER_LIVE=1 npx vitest run lib/agent-tools/computer/trajectory-live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runComputerAction } from './computer';
import { ensureHiveDesktop, releaseHiveDesktop } from './desktop-lease';
import { __resetAllLedgersForTests } from './action-ledger';
import { readRecording, startRecording, stopRecording } from './trajectory-recorder';
import { createFfmpegExec, exportPointerLine, exportRecording } from './trajectory-export';

const HIVE = 'trajectory-live-proof';

function hasBin(bin: string): boolean {
  try {
    return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}
const liveEnabled =
  process.env.PAPERCUSP_COMPUTER_LIVE === '1' &&
  ['Xvfb', 'xdotool', 'import', 'xdpyinfo', 'openbox', 'ffmpeg', 'ffprobe'].every(hasBin);

/** Container duration in seconds, straight from ffprobe — not from our own model. */
function probeDurationSec(path: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  return Number.parseFloat(r.stdout.toString().trim());
}

/** Decoded frame count — the GIF's own answer to "did every step survive?". */
function probeFrameCount(path: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  return Number.parseInt(r.stdout.toString().trim(), 10);
}

describe.skipIf(!liveEnabled)('computer:record — LIVE trajectory recording + encode', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-live-rec-'));

  afterAll(async () => {
    await releaseHiveDesktop(HIVE);
    rmSync(root, { recursive: true, force: true });
  });

  it('records one frame per ACTION on a real desktop and encodes a playable webm + gif', async () => {
    delete process.env.PAPERCUSP_COMPUTER_DISPLAY;
    delete process.env.PAPERCUSP_AGENT_DISPLAY;
    __resetAllLedgersForTests();

    const desktop = await ensureHiveDesktop(HIVE);
    expect(desktop.display).not.toBe(':0');

    const rec = startRecording({ display: desktop.display, root, workItem: 'WI-40938', note: 'P-009 live proof' });

    // Six real actions, deliberately mixing observe modes so BOTH recorder paths run
    // live: `image` steps must REUSE the returned pixels, `none` steps must capture.
    const shot = await runComputerAction(
      { action: 'mouse_move', coordinate: [100, 100], observe: 'image' },
      { harnessSlug: HIVE },
    );
    const returnedImage = shot.content.find((c) => c.type === 'image') as { data: string } | undefined;
    expect(returnedImage).toBeTruthy();

    for (const coordinate of [[200, 150], [300, 200], [400, 250], [500, 300]] as Array<[number, number]>) {
      const r = await runComputerAction({ action: 'mouse_move', coordinate, observe: 'none' }, { harnessSlug: HIVE });
      expect(r.isError).toBeFalsy();
      // A real inter-action gap, so the concat durations are measured and not all
      // pinned to the 0.2s floor — which is what makes the ffprobe assertion mean
      // something.
      await new Promise((r2) => setTimeout(r2, 350));
    }
    await runComputerAction({ action: 'key', text: 'Escape', observe: 'none' }, { harnessSlug: HIVE });

    const stopped = stopRecording(desktop.display);
    expect(stopped?.endReason).toBe('stopped');
    expect(stopped?.lastError).toBeNull();

    const loaded = readRecording(rec.dir);
    expect(loaded.frames).toHaveLength(6); // one per action, no more and no fewer
    expect(loaded.droppedFrames).toBe(0);
    expect(loaded.frames[0]!.reused).toBe(true); // the observe:'image' step
    expect(loaded.frames.slice(1).every((f) => !f.reused)).toBe(true);

    // D-013 §2, proven on real pixels: the stored frame IS the image the model saw.
    expect(readFileSync(join(rec.dir, loaded.frames[0]!.file))).toEqual(
      Buffer.from(returnedImage!.data, 'base64'),
    );
    // …and every frame is a genuine PNG the encoder can read.
    for (const f of loaded.frames) {
      expect(readFileSync(join(rec.dir, f.file)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }

    const exec = createFfmpegExec(120_000);
    const webm = await exportRecording(rec.dir, { format: 'webm', exec });
    expect(webm.frames).toBe(6);
    expect(webm.bytes).toBeGreaterThan(0);

    // THE ASSERTION THAT ONLY A LIVE ENCODE CAN MAKE: the container's real duration
    // matches the timing model. A wrong clamp, a dropped last frame, or a concat
    // script ffmpeg silently mis-parses all show up here and nowhere else.
    const probed = probeDurationSec(webm.path);
    expect(Number.isFinite(probed)).toBe(true);
    expect(probed).toBeGreaterThan(1);
    expect(Math.abs(probed - webm.playbackSec)).toBeLessThan(0.75);

    const gif = await exportRecording(rec.dir, { format: 'gif', exec });
    expect(gif.bytes).toBeGreaterThan(0);
    // Every recorded step survives into the GIF, PLUS the deliberate duplicate of the
    // last frame — that repeat is what buys the final state its full hold instead of
    // one default-duration flash (measured both ways; see buildConcatScript). Pinning
    // the exact +1 is what would catch the repeat being silently dropped OR doubled.
    expect(probeFrameCount(gif.path)).toBe(7);

    // eslint-disable-next-line no-console
    console.log(
      `[P-009] live: ${loaded.frames.length} frames · webm ${(webm.bytes / 1024).toFixed(0)}KB ` +
        `probed ${probed.toFixed(2)}s vs modelled ${webm.playbackSec}s · gif ${(gif.bytes / 1024).toFixed(0)}KB ` +
        `${probeFrameCount(gif.path)} frames`,
    );
    // eslint-disable-next-line no-console
    console.log(`[P-009] pointer: ${exportPointerLine(webm).split('\n')[0]}`);
  }, 180_000);

  it('costs the agent NOTHING in returned bytes: a recorded step is byte-identical to an unrecorded one', async () => {
    const desktop = await ensureHiveDesktop(HIVE);
    __resetAllLedgersForTests();

    // ⚠ The two moves MUST target different coordinates. Moving to where the pointer
    // already is takes ~15.2s under a window manager and is then SIGKILLed by the
    // 15s exec timeout mid-`--sync`, so the action reports FAILED and the click never
    // fires — EI-21256574817493619, found by this very test. Distinct coordinates keep
    // this test measuring the recorder rather than that defect.
    const before = await runComputerAction(
      { action: 'mouse_move', coordinate: [11, 11], observe: 'none' },
      { harnessSlug: HIVE },
    );
    startRecording({ display: desktop.display, root, note: 'invisibility check' });
    const during = await runComputerAction(
      { action: 'mouse_move', coordinate: [12, 12], observe: 'none' },
      { harnessSlug: HIVE },
    );
    stopRecording(desktop.display);

    // Normalise the two things that legitimately differ between any two steps — the
    // ledger seq and the coordinate — so what remains is exactly the shape and size
    // of what the agent was handed.
    const strip = (r: typeof before) =>
      r.content.map((c) =>
        c.type === 'text'
          ? c.text.replace(/^#\d+/, '#N').replace(/\(\d+,\d+\)/, '(X,Y)')
          : `image:${c.data.length}`,
      );
    expect(strip(during)).toEqual(strip(before));
  }, 120_000);
});
