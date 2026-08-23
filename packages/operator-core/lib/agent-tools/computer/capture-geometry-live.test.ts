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
 * WHY THE GEOMETRY TESTS AND THE CONTENT TEST ARE SEPARATE — this split is load-bearing.
 * Shrinking an image always "saves tokens"; shrinking it to garbage saves more. So the
 * measurement deserves a companion check that the screen SURVIVED the resize. But that
 * check needs something painted on the desktop, and painting inside a provisioned desktop
 * is currently broken here for reasons that have nothing to do with capture geometry
 * (every window comes up 1x1 under the provisioned openbox — EI-21229784052420840).
 *
 * Folding both into one test made that defect able to masquerade as a capture-geometry
 * regression, and skipping that combined test threw away the geometry evidence with it —
 * vitest reports a `ctx.skip()` test as SKIPPED even for assertions that already ran and
 * passed, which is a green that proves nothing. So: the geometry + token claims are read
 * from the PNG headers, hold whether or not anything was drawn, and ALWAYS run. Only the
 * content claim depends on a painted desktop, and only it skips when that precondition is
 * unmet.
 *
 * GUARDED like the other live desktop suites — a normal `test:affected` / CI run (no opt-in,
 * usually no X) skips the whole file:
 *   PAPERCUSP_CAPTURE_GEOMETRY_LIVE=1 npx vitest run lib/agent-tools/computer/capture-geometry-live.test.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { analyzeImageBlankness } from '@papercusp/image-blankness';
import { afterEach, describe, expect, it } from 'vitest';
import { captureCommand, captureFit, sandboxXEnv, type DesktopTarget } from './desktop-driver';
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
  const r = spawnSync(cmd.bin, cmd.args, { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
  expect(r.status, `capture failed: ${r.stderr?.toString().slice(0, 300)}`).toBe(0);
  return r.stdout;
}

/** Let a freshly-launched app map and paint before capturing it. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Paint something with REAL detail on the display, and keep it up for `holdSec`.
 *
 * Three things here were each learned the expensive way:
 *
 *  - `sandboxXEnv(display)`, NOT `{ ...process.env, DISPLAY }`. This operator process runs
 *    with the host's own session in its env (measured: DISPLAY=:0,
 *    XAUTHORITY=/run/user/1000/gdm/Xauthority); handing an app a host gdm cookie while
 *    pointing it at a sandbox display is what `stripHostX` exists to prevent. It also
 *    matches how the provisioner launches every real app.
 *  - `-e /bin/sh -c '<script>'`, NOT `-e '<script>'`. Given a single argument xterm
 *    WORD-SPLITS it and execs the first token directly, so a pipe becomes an argument to
 *    `ls`: it errors and xterm exits 1 (observed as a 1x1 window titled
 *    "bin | head -100; sleep 40"). An explicit shell removes the heuristic.
 *  - CONTENT matters as much as the window: a bare xterm renders as a dark rectangle on a
 *    dark root — 2 distinct colours, ~0.1% edge density, right at the blankness detector's
 *    floor, i.e. a coin-flip probe. White-on-black full of `ls -la` output measures 1,690
 *    colours at 1920x1080, which is unambiguous.
 */
function paintDetail(display: string, holdSec: number): { errors: () => string } {
  const child = spawn(
    'xterm',
    [
      '-bg', 'white', '-fg', 'black',
      '-fa', 'Monospace', '-fs', '10',
      '-geometry', '200x60+0+0',
      '-e', '/bin/sh', '-c', `ls -la /usr/bin | head -100; sleep ${holdSec}`,
    ],
    { env: sandboxXEnv(display), stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // Keep stderr: a content probe that fails SILENTLY turns every assertion downstream into
  // a mystery ("did the downscale break it?" — no, the app never started).
  let err = '';
  child.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });
  child.on('error', (e) => {
    err += String(e);
  });
  child.unref();
  return { errors: () => err.trim() };
}

describe.skipIf(!LIVE)('D-006 capture geometry — measured on a real display', () => {
  let desktop: SandboxDesktop | undefined;

  afterEach(async () => {
    await desktop?.release();
    desktop = undefined;
  });

  it('serves a 1920x1080 desktop to the model at 1024x576, at ~3.5x fewer tokens', async () => {
    // A frame slot's real geometry (deployment config default; display-allocator registers
    // exactly this), which is the population D-006 is about.
    desktop = await provisionSandboxDesktop({ width: 1920, height: 1080, apps: [] });

    const display: DesktopTarget = { display: desktop.display, width: 1920, height: 1080 };
    const agent: DesktopTarget = { ...display, capture: { width: 1024, height: 768 } };

    const before = pngSize(capture(display));
    const after = pngSize(capture(agent));

    // BEFORE: the human's geometry — what the agent used to be served.
    expect(before).toEqual({ width: 1920, height: 1080 });

    // AFTER: aspect-preserved into the box — 1024x576, NOT 1024x768. This is the assertion
    // that pins captureFit() to ImageMagick's ACTUAL behaviour rather than to our model of
    // it, and it is the reason this file has to touch a real display at all.
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
  }, 60_000);

  it('leaves a display SMALLER than the box untouched — never magnifies it', async () => {
    // The trap, proven live: `-resize 1024x768` without the `>` returns 1024x768 here and
    // costs 1.6x MORE tokens than the 800x600 screen it came from.
    desktop = await provisionSandboxDesktop({ width: 800, height: 600, apps: [] });

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

  it('downscaling preserves the screen — a cheaper capture that shows nothing is not a win', async (ctx) => {
    desktop = await provisionSandboxDesktop({ width: 1920, height: 1080, apps: [] });
    const probe = paintDetail(desktop.display, 40);
    await wait(4000); // the window must map AND paint before either capture means anything

    const display: DesktopTarget = { display: desktop.display, width: 1920, height: 1080 };
    const agent: DesktopTarget = { ...display, capture: { width: 1024, height: 768 } };

    const beforeBuf = capture(display);
    const afterBuf = capture(agent);

    // PRECONDITION, checked first and separately: is there a screen to preserve at all? A
    // blank full-size capture means nothing painted, which says nothing either way about
    // downscaling — so skip rather than report a capture-geometry failure. The geometry and
    // token evidence lives in the tests above and is unaffected by this skipping.
    const beforeVerdict = analyzeImageBlankness(beforeBuf);
    if (beforeVerdict.verdict === 'blank') {
      ctx.skip(
        `precondition not met: the FULL-SIZE capture is blank (${beforeVerdict.reason}). ` +
          `Nothing painted on this desktop — see EI-21229784052420840 (windows come up 1x1 under ` +
          `the provisioned openbox). This is a desktop-provisioning defect, NOT a capture-geometry ` +
          `regression. Content-probe stderr: ${probe.errors() || '(none)'}`,
      );
      return;
    }

    // The real assertion: full-size had content, so the downscaled one must too. This is
    // what catches a resize that "saves tokens" by destroying the observation.
    const afterVerdict = analyzeImageBlankness(afterBuf);
    expect(
      afterVerdict.verdict,
      `the full-size capture had content but the DOWNSCALED one is ${afterVerdict.verdict} ` +
        `(${afterVerdict.reason}) — the resize destroyed the observation`,
    ).not.toBe('blank');
  }, 60_000);
});
