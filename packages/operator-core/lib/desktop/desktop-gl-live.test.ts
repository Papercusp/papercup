/**
 * desktop-gl-live.test.ts — P-002's falsifiable proof: a GL app on a provisioned sandbox
 * desktop paints REAL PIXELS, and this test can tell the difference.
 *
 * WHY THIS EXISTS AS A LIVE TEST AND NOT A UNIT TEST. Everything else in this feature is
 * checkable in-process: the ladder is pure, and `gl-strategy.test.ts` even executes the
 * shell projection. But the entire bug being fixed is that *the probes lie* — `glxinfo`
 * exits 0 and reports a renderer on a display where WebKitGTK still paints nothing, so an
 * assertion built on any probe's output is exactly the assertion that cannot detect the
 * failure. The only claim that can is: capture the framebuffer and judge the pixels.
 *
 * THE CONTROL IS THE POINT — read this before trusting the assertion below it. The first
 * test screenshots an EMPTY desktop and requires the verdict `blank`. Without it, a
 * detector that answered `has-content` for everything would make the second test pass on a
 * completely broken GL stack, and the suite would be worse than no suite: a green check
 * asserting the exact thing that is false. The pair is the test; neither half alone is
 * evidence. (Repo rule: an absence claim needs a positive control. This is its inverse and
 * the same discipline.)
 *
 * Measured on the dev box (2026-08-23, NVIDIA RTX 3090 + mesa 20.1.2, `Xvfb :192`), which
 * is where the thresholds below come from — the two populations are not close:
 *     empty framebuffer  → 1 distinct colour, stddev 0,    233 bytes
 *     glxgears painting  → 383 distinct colours, stddev 18.8, 9,365 bytes
 *
 * SCOPE, stated honestly: this proves GL output reaches the X framebuffer and that a
 * capture of it carries real content. It does NOT exercise WebKitGTK's EGL/X11 compositor,
 * which is the specific consumer the insight doc burned hours on — that needs the Tauri
 * shell and belongs to `scripts/verify-tauri-headless.sh` (which already selects the same
 * VirtualGL rung this module now owns). What this closes is the substrate half: a desktop
 * handed to an agent either paints or is recorded as `tier: 'none'`.
 *
 * GUARDED, like `computer-live.test.ts`: runs only under `PAPERCUSP_DESKTOP_GL_LIVE=1`
 * with the X tooling present, so a normal `test:affected` / CI run (no opt-in, usually no
 * X) skips it:
 *   PAPERCUSP_DESKTOP_GL_LIVE=1 npx vitest run lib/desktop/desktop-gl-live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { analyzeImageBlankness } from '@papercusp/image-blankness';
import { afterEach, describe, expect, it } from 'vitest';
import { captureCommand } from '../agent-tools/computer/desktop-driver';
import {
  provisionSandboxDesktop,
  type SandboxDesktop,
} from '../agent-tools/computer/desktop-provisioner';
import { detectGlStrategy } from './gl-strategy';

function hasBin(bin: string): boolean {
  try {
    return spawnSync('which', [bin], {
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    }).status === 0;
  } catch {
    return false;
  }
}

const REQUIRED = ['Xvfb', 'xdpyinfo', 'import', 'openbox', 'glxinfo', 'glxgears'];
const liveEnabled = process.env.PAPERCUSP_DESKTOP_GL_LIVE === '1' && REQUIRED.every(hasBin);

/** Capture the root window of `display` as PNG bytes, via the same command the driver uses. */
function capture(display: string): Uint8Array {
  const { bin, args } = captureCommand({ display, width: 1024, height: 768 });
  const res = spawnSync(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
  if (res.status !== 0) throw new Error(`capture of ${display} failed: ${res.stderr?.toString() ?? ''}`);
  return new Uint8Array(res.stdout);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!liveEnabled)('P-002 — a GL app on a sandbox desktop paints real pixels', () => {
  let desktop: SandboxDesktop | undefined;

  afterEach(async () => {
    await desktop?.release();
    desktop = undefined;
  });

  it('CONTROL: an empty desktop reads as blank — the detector can fail', async () => {
    // If this ever goes green-by-passing (verdict !== 'blank'), the assertion in the next
    // test proves nothing, because a detector that never says "blank" would pass it on a
    // dead GL stack. This test failing is how you learn the next one is meaningless.
    desktop = await provisionSandboxDesktop({ width: 1024, height: 768, apps: [] });
    await wait(1000);

    const report = analyzeImageBlankness(capture(desktop.display));
    expect(
      report.verdict,
      `an EMPTY framebuffer was judged ${report.verdict} (${report.reason}) — the blankness detector is not discriminating, so the non-blank assertion in this file is void`,
    ).toBe('blank');
  }, 60_000);

  it('a GL app paints content the capture path can see', async () => {
    desktop = await provisionSandboxDesktop({
      width: 1024,
      height: 768,
      apps: [['glxgears']],
    });

    // The desktop must have a working GL stack for this claim to be meaningful at all. On a
    // host with none, the honest outcome is a recorded `tier: 'none'`, not a failed
    // assertion about pixels — so say which it is rather than reporting a confusing red.
    expect(
      desktop.gl.tier,
      `no GL on this host (${desktop.gl.reason}) — install ${'libgl1-mesa-dri'} before running the live GL suite`,
    ).not.toBe('none');

    await wait(3000); // let gears render a few frames into the framebuffer

    const report = analyzeImageBlankness(capture(desktop.display));
    expect(
      report.verdict,
      `GL app screenshot judged ${report.verdict} (${report.reason}) on a desktop reporting gl.tier=${desktop.gl.tier} via ${desktop.gl.id} — this is the blank-screenshot trap: the strategy claimed GL, the pixels disagree`,
    ).toBe('has-content');

    // Beyond the verdict: the measured margin should be nowhere near the threshold. A frame
    // that only just clears it is a warning that the app painted almost nothing.
    expect(report.distinctColors ?? 0).toBeGreaterThan(8);
  }, 60_000);

  it('records a measured GL strategy on the provisioned desktop (feeds D-004 capabilities)', async () => {
    desktop = await provisionSandboxDesktop({ width: 1024, height: 768, apps: [] });

    // Measured, not assumed: the strategy must be one the ladder actually observed on THIS
    // display, and it must agree with an independent detection against the same display.
    expect(['virtualgl', 'native', 'mesa-software', 'none']).toContain(desktop.gl.id);
    expect(desktop.gl.reason).toBeTruthy();

    const redetected = detectGlStrategy(desktop.display);
    expect(
      redetected.tier,
      'the GL tier changed between two probes of the same live display — the measurement is not stable',
    ).toBe(desktop.gl.tier);

    if (desktop.gl.tier !== 'none') {
      expect(desktop.gl.renderer, 'a non-none tier must name the renderer it observed').toBeTruthy();
    }
  }, 60_000);
});
