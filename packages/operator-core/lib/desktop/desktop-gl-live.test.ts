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
  type DesktopAppDiagnostic,
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

/**
 * P-012 — the same suite, against the KasmVNC backend.
 *
 * This is what "local-dev Xvfb parity pinned by test" means concretely: not a second
 * suite that resembles this one, but THESE assertions run over both backends, because
 * both are the same `provisionSandboxDesktop` call with one argument changed. If a
 * future change makes the kasmvnc path diverge — a different GL measurement, a capture
 * that comes back blank, an unstable probe — it fails here rather than on a customer's
 * VM, where the symptom is a desktop that serves grey pixels and no error.
 *
 * Guarded separately from `liveEnabled` because KasmVNC arrives via the opt-in desktop
 * pack, so a dev box that never opted in legitimately does not have it. Skipping is
 * correct there; claiming parity without the binary would not be.
 */
const kasmvncEnabled = liveEnabled && hasBin('Xkasmvnc') && hasBin('kasmvncpasswd');

/**
 * Backends this run can actually exercise. `xvfb` is always in the list when the live
 * suite runs at all; `kasmvnc` joins it only when the pack is installed.
 */
const BACKENDS: Array<{ xServer: 'xvfb' | 'kasmvnc'; enabled: boolean }> = [
  { xServer: 'xvfb', enabled: liveEnabled },
  { xServer: 'kasmvnc', enabled: kasmvncEnabled },
];

/** Capture the root window of `display` as PNG bytes, via the same command the driver uses. */
function capture(display: string): Uint8Array {
  const { bin, args } = captureCommand({ display, width: 1024, height: 768 });
  const res = spawnSync(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
  if (res.status !== 0) throw new Error(`capture of ${display} failed: ${res.stderr?.toString() ?? ''}`);
  return new Uint8Array(res.stdout);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Capture `display` repeatedly until the frame carries content, or `timeoutMs` elapses.
 *
 * WHY THIS EXISTS, and why it is not the `await wait(3000)` it replaced (WI-1105361): a fixed
 * sleep before a pixel assertion encodes a GUESS about how long provisioning plus first paint
 * takes, and that guess is load-dependent. Measured on a 128-core host whose 1-minute loadavg
 * ranged 92-384, the 3s form failed TWO RUNS IN THREE while passing the third with byte-identical
 * code — the frame simply had not painted yet at the single instant it was sampled. Both GL
 * assertions in this file shared the constant, which is why they always failed together and
 * looked like one deterministic regression rather than one shared flake.
 *
 * This keeps the guarantee the sleep was there to provide. A desktop that NEVER paints still
 * returns a blank report and still fails the caller; polling only removes the false negative
 * where the app painted slightly later than one hardcoded constant allowed. It is deliberately
 * NOT "raise 3000 to something bigger" — that trades a fast flake for a slow one and leaves the
 * defect class in place.
 *
 * `elapsedMs` comes back so a genuinely slow first paint stays VISIBLE in the failure message
 * instead of being silently absorbed by a longer timeout: a frame that needed 20s is a real
 * finding about the desktop, even on the run where it eventually passes.
 *
 * ⚠ POLLING ALONE STILL CANNOT TELL YOU WHY (WI-1105361, measured 2026-08-30). With the sleep
 * replaced by this poll, the suite still failed 2 runs in 4 — but now with `after 30183ms of
 * polling`, and the run that passed painted in 2247ms. That is BIMODAL, not a load gradient:
 * a frame that is slow arrives late, a frame that is never coming does not arrive at all, and
 * 30s of identical blank captures cannot distinguish "the app painted nothing" from "the app
 * exited before it could paint". Both read as `verdict: blank` on a desktop whose GL ladder
 * measured `hardware`, which is why the failure looked like an indictment of the GL strategy.
 *
 * So the loop watches the PROCESS as well as the pixels. If every app has exited, the answer
 * has already arrived and waiting out the remaining timeout only delays it — we stop and hand
 * back the diagnostics (exit code, signal, and the app's own stderr, which is where
 * `[VGL] ERROR:` and `bwrap:` refusals surface). `appExited` says which question the caller is
 * actually looking at, so a failure message can name the app's death rather than blame GL.
 */
async function captureWhenPainted(
  desktop: SandboxDesktop,
  timeoutMs = 30_000,
): Promise<{
  report: ReturnType<typeof analyzeImageBlankness>;
  elapsedMs: number;
  appExited: boolean;
  diagnostics: DesktopAppDiagnostic[];
}> {
  const startedAt = Date.now();
  let report = analyzeImageBlankness(capture(desktop.display));
  let diagnostics = desktop.appDiagnostics();
  // "Every app is gone" — not "any", because a desktop may legitimately run a helper that
  // exits after doing its job while the app that paints is still running.
  const allExited = () => diagnostics.length > 0 && diagnostics.every((d) => !d.alive);
  while (report.verdict !== 'has-content' && Date.now() - startedAt < timeoutMs && !allExited()) {
    await wait(250);
    report = analyzeImageBlankness(capture(desktop.display));
    diagnostics = desktop.appDiagnostics();
  }
  return { report, elapsedMs: Date.now() - startedAt, appExited: allExited(), diagnostics };
}

/**
 * Render the app diagnostics into a failure message. Kept separate so every assertion in
 * this file reports the same way — a caller that formats its own is one that will forget
 * the stderr, which is the whole point of collecting it.
 */
function describeApps(diagnostics: readonly DesktopAppDiagnostic[]): string {
  if (diagnostics.length === 0) return 'no apps were spawned on this desktop';
  return diagnostics
    .map((d) => {
      const state = d.alive
        ? 'STILL RUNNING'
        : `EXITED code=${d.exitCode ?? 'null'} signal=${d.exitSignal ?? 'null'}`;
      const stderr = d.stderrTail.trim();
      return `${d.argv.join(' ')} [pid=${d.pid ?? '?'}] ${state}${
        stderr ? `\n    stderr: ${stderr.replace(/\n/g, '\n            ')}` : ' (stderr: empty)'
      }`;
    })
    .join('\n  ');
}

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

    // Poll for first paint rather than sleeping a fixed interval and hoping — see
    // captureWhenPainted. A desktop that never paints still fails here.
    const { report, elapsedMs, appExited, diagnostics } = await captureWhenPainted(desktop);
    expect(
      report.verdict,
      `GL app screenshot judged ${report.verdict} (${report.reason}) after ${elapsedMs}ms of polling on a desktop reporting gl.tier=${desktop.gl.tier} via ${desktop.gl.id}.\n` +
        (appExited
          ? '  THE APP EXITED — this is NOT the blank-screenshot trap and not a verdict on the GL\n' +
            '  strategy: nothing was running to paint. Read its stderr below.\n  '
          : '  This is the blank-screenshot trap: the strategy claimed GL, the app is still running,\n' +
            '  and the pixels disagree.\n  ') +
        describeApps(diagnostics),
    ).toBe('has-content');

    // Beyond the verdict: the measured margin should be nowhere near the threshold. A frame
    // that only just clears it is a warning that the app painted almost nothing.
    expect(report.distinctColors ?? 0).toBeGreaterThan(8);

    // …and WHICH renderer painted them, not merely that something did (WI-1105361 / D-031).
    //
    // THIS IS THE GUARD THAT WAS MISSING. Every assertion above passes on SOFTWARE pixels:
    // llvmpipe is a working rasterizer, so a `hardware` desktop that silently fell back to
    // it still paints, still clears the colour threshold, and still reads green. That is
    // precisely how a sandbox binding `/dev/dri` but no `/dev/nvidia*` hid — for the whole
    // life of P-002 — behind a suite that only ever asked whether pixels existed.
    //
    // The fallback announces itself in the app's OWN stderr, which is already collected
    // here, so this costs nothing extra: libglvnd failing over to the Mesa ICD on an NVIDIA
    // device prints `driver (null)` and then `failed to create dri2 screen`.
    if (desktop.gl.tier === 'hardware') {
      const stderr = diagnostics.map((d) => d.stderrTail).join('\n');
      expect(
        /driver \(null\)|failed to create dri2 screen/.test(stderr),
        `the desktop reports gl.tier=hardware via ${desktop.gl.id}, but the app's EGL fell back\n` +
          '  to a software vendor INSIDE the sandbox — so the hardware claim is not being kept.\n' +
          '  D-031: the GL ladder probes OUTSIDE the sandbox, where the GPU always works, so it\n' +
          '  can record `hardware` while the app inside reaches llvmpipe. Check that the vendor\n' +
          '  device nodes are bound for this tier (discoverGpuDeviceNodes in desktop-sandbox.ts).\n  ' +
          describeApps(diagnostics),
      ).toBe(false);
    }
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

/**
 * P-012 — BACKEND PARITY. The three claims above, re-run over every available backend.
 *
 * Measured 2026-08-30 on a KasmVNC 1.5.0 desktop with `/dev/dri` hidden (the GPU-less
 * BYOC condition reproduced in a mount namespace), which is where the expectations
 * come from and why the pair below is the evidence rather than either half:
 *     empty framebuffer            → verdict blank,       1 distinct colour
 *     WebKitGTK MiniBrowser page   → verdict has-content, 133 distinct colours
 *     gl-strategy on that display  → mesa-software / llvmpipe (LLVM 20.1.2)
 * The same display measured `virtualgl / hardware (RTX 3090)` with the DRI nodes
 * visible, so the software rung is a real measurement of a real condition and not a
 * probe that failed shut.
 */
describe.each(BACKENDS)('P-012 — $xServer backend parity', ({ xServer, enabled }) => {
  let desktop: SandboxDesktop | undefined;

  afterEach(async () => {
    await desktop?.release();
    desktop = undefined;
  });

  it.skipIf(!enabled)('reports the backend it was actually booted on', async () => {
    desktop = await provisionSandboxDesktop({ width: 1024, height: 768, apps: [], xServer });
    // D-007: the registry row is the AUTHORIZATION, so what it records has to be true.
    // A kasmvnc desktop mislabelled `xvfb-local` would tell P-013's viewer lane there
    // is nothing to connect to, and an xvfb desktop claiming an endpoint would send it
    // dialling a port that does not exist.
    expect(desktop.xServer).toBe(xServer);
    if (xServer === 'kasmvnc') {
      expect(desktop.endpoint?.host).toBe('127.0.0.1');
      expect(desktop.endpoint?.port).toBeGreaterThan(0);
      expect(desktop.credentials?.view.user).toBeTruthy();
      expect(desktop.credentials?.control.user).toBeTruthy();
      // The two credentials must be genuinely different secrets, not one reused with
      // two names — otherwise the view/takeover split is cosmetic.
      expect(desktop.credentials?.view.secret).not.toBe(desktop.credentials?.control.secret);
    } else {
      // Xvfb runs `-nolisten tcp`. The absence here is the local path's "no listener,
      // ever" property, and it is asserted so a future refactor cannot quietly add one.
      expect(desktop.endpoint).toBeUndefined();
      expect(desktop.credentials).toBeUndefined();
    }
  }, 90_000);

  it.skipIf(!enabled)('CONTROL: an empty desktop reads as blank on this backend', async () => {
    desktop = await provisionSandboxDesktop({ width: 1024, height: 768, apps: [], xServer });
    await wait(1000);
    const report = analyzeImageBlankness(capture(desktop.display));
    expect(
      report.verdict,
      `an EMPTY ${xServer} framebuffer was judged ${report.verdict} (${report.reason}) — the ` +
        'detector is not discriminating, so the non-blank assertion below it proves nothing',
    ).toBe('blank');
  }, 90_000);

  it.skipIf(!enabled)('a GL app paints real pixels on this backend', async () => {
    desktop = await provisionSandboxDesktop({
      width: 1024,
      height: 768,
      apps: [['glxgears']],
      xServer,
    });
    expect(
      desktop.gl.tier,
      `no GL on this host (${desktop.gl.reason}) — the ${xServer} desktop cannot be trusted for ` +
        'pixel evidence, which is a recorded capability, not a test failure to route around',
    ).not.toBe('none');
    const { report, elapsedMs, appExited, diagnostics } = await captureWhenPainted(desktop);
    expect(
      report.verdict,
      `GL app screenshot judged ${report.verdict} after ${elapsedMs}ms of polling on a ${xServer} desktop reporting ` +
        `gl.tier=${desktop.gl.tier} via ${desktop.gl.id}.\n` +
        (appExited
          ? '  THE APP EXITED — nothing was running to paint, so this is not a verdict on the GL\n' +
            '  strategy on this backend. Read its stderr below.\n  '
          : '  The strategy claimed GL, the app is still running, and the pixels disagree.\n  ') +
        describeApps(diagnostics),
    ).toBe('has-content');
    expect(report.distinctColors ?? 0).toBeGreaterThan(8);
  }, 90_000);
});
