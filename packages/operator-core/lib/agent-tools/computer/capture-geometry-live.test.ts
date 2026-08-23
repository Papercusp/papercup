/**
 * capture-geometry-live.test.ts — D-006's required evidence, measured rather than asserted.
 *
 * The decision (plan agent-virtual-desktops-2026-08-23, D-006 / P-006) says explicitly:
 * "EVIDENCE REQUIRED at P-006: measured before/after per-step token counts on the
 * implementing work-item — not an assertion that the resolution changed." This file is
 * that measurement, run against a real Xvfb and a real ImageMagick.
 *
 * WHY IT CANNOT BE A UNIT TEST. `captureFit()` is pure and unit-tested, but it is only a
 * MODEL of what ImageMagick does. The whole saving depends on `import -resize 'WxH>'`
 * behaving the way the model believes, and that belief is exactly the kind of thing that
 * is wrong in a way no in-process test can see: the `>` suffix is a shrink-only flag, and
 * dropping it silently MAGNIFIES an 800x600 display to 1024x768 — a token INCREASE from
 * the change meant to cut cost. Only a real capture can falsify the model.
 *
 * THE SECOND ASSERTION IS THE IMPORTANT ONE. Shrinking an image always "saves tokens";
 * shrinking it to garbage saves more. So every geometry assertion here is paired with a
 * blankness check on the SAME bytes: a capture that got cheaper and stopped carrying the
 * screen is a regression, not a win, and a suite that only counted pixels would call it a
 * success. (Same discipline as desktop-gl-live.test.ts's blank control, inverted.)
 *
 * GUARDED like the other live desktop suites — a normal `test:affected` / CI run (no opt-in,
 * usually no X) skips the whole file:
 *   PAPERCUSP_CAPTURE_GEOMETRY_LIVE=1 npx vitest run lib/agent-tools/computer/capture-geometry-live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { analyzeImageBlankness } from '@papercusp/image-blankness';
import { afterEach, describe, expect, it } from 'vitest';
import { captureCommand, captureFit, type DesktopTarget } from './desktop-driver';
import { provisionSandboxDesktop, type SandboxDesktop } from './desktop-provisioner';

const LIVE = process.env.PAPERCUSP_CAPTURE_GEOMETRY_LIVE === '1';

/**
 * Claude meters an image at about (w*h)/750 tokens (D-006, from the WI-40780 report).
 * This is the arithmetic the whole decision rests on, so it is written once, here.
 */
const tokensFor = (w: number, h: number): number => Math.round((w * h) / 750);

/**
 * Read a PNG's real dimensions from its IHDR chunk — 8-byte signature, 4-byte length,
 * 4-byte "IHDR", then width and height as big-endian uint32.
 *
 * Deliberately parsed from the BYTES rather than trusting the command we asked for: the
 * point of a live test is to measure what actually came back.
 */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function capture(target: DesktopTarget): Buffer {
  const cmd = captureCommand(target);
  const r = spawnSync(cmd.bin, cmd.args, { maxBuffer: 64 * 1024 * 1024 });
  expect(r.status, `capture failed: ${r.stderr?.toString().slice(0, 300)}`).toBe(0);
  return r.stdout;
}

describe.skipIf(!LIVE)('D-006 capture geometry — measured on a real display', () => {
  let desktop: SandboxDesktop | undefined;

  afterEach(async () => {
    await desktop?.release();
    desktop = undefined;
  });

  it('serves a 1920x1080 desktop to the model at 1024x576, at ~3.5x fewer tokens', async () => {
    // A frame slot's real geometry (deployment config default; display-allocator
    // registers exactly this), which is the population D-006 is about.
    desktop = await provisionSandboxDesktop({ width: 1920, height: 1080, apps: [['xterm']] });

    const display: DesktopTarget = { display: desktop.display, width: 1920, height: 1080 };
    const agent: DesktopTarget = { ...display, capture: { width: 1024, height: 768 } };

    const before = pngSize(capture(display));
    const afterBuf = capture(agent);
    const after = pngSize(afterBuf);

    // BEFORE: the human's geometry, which is what the agent used to be served.
    expect(before).toEqual({ width: 1920, height: 1080 });

    // AFTER: aspect-preserved into the box — 1024x576, NOT 1024x768. This is the
    // assertion that pins captureFit() to ImageMagick's actual behaviour.
    expect(after).toEqual({ width: 1024, height: 576 });
    expect(after).toEqual({ width: captureFit(agent).width, height: captureFit(agent).height });

    // THE MEASUREMENT D-006 ASKED FOR.
    const beforeTokens = tokensFor(before.width, before.height); // ~2,765
    const afterTokens = tokensFor(after.width, after.height); //  ~786
    // eslint-disable-next-line no-console -- this number IS the deliverable
    console.log(
      `[D-006] per-observation image tokens: before=${beforeTokens} after=${afterTokens} ` +
        `saving=${(beforeTokens / afterTokens).toFixed(2)}x (display ${before.width}x${before.height} → capture ${after.width}x${after.height})`,
    );
    expect(beforeTokens / afterTokens).toBeGreaterThan(2.5);

    // …AND THE SCREEN SURVIVED IT. Without this, "saved 3.5x" is satisfied by a capture
    // that returns nothing — cheaper and useless. xterm is painted by plain X11, so this
    // needs no GL and is a fair content check on a bare Xvfb.
    const verdict = analyzeImageBlankness(afterBuf);
    expect(verdict.verdict, `downscaled capture lost the screen: ${JSON.stringify(verdict)}`).not.toBe('blank');
  }, 60_000);

  it('leaves a display SMALLER than the box untouched — never magnifies it', async () => {
    // The trap, proven live: `-resize 1024x768` (no `>`) would return 1024x768 here and
    // cost 1.6x MORE tokens than the 800x600 screen it came from.
    desktop = await provisionSandboxDesktop({ width: 800, height: 600, apps: [['xterm']] });

    const agent: DesktopTarget = {
      display: desktop.display,
      width: 800,
      height: 600,
      capture: { width: 1024, height: 768 },
    };
    const size = pngSize(capture(agent));

    expect(size).toEqual({ width: 800, height: 600 });
    expect(tokensFor(size.width, size.height)).toBeLessThan(tokensFor(1024, 768));
  }, 60_000);
});
