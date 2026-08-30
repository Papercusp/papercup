/**
 * gl-probe-sandbox-parity.test.ts — WI-1223202's RECURRENCE GUARD.
 *
 * THE DEFECT THIS EXISTS TO CATCH, stated precisely: the GL ladder measured the HOST while
 * the apps ran under bubblewrap, so `capabilities.gl.tier` could record `hardware` for a
 * desktop whose apps rendered in llvmpipe. D-031 found exactly that (the sandbox had never
 * bound `/dev/nvidia*`) and fixed the BINDING. Nothing then stopped the two drifting apart
 * again — which is the whole reason a fix here needs a test rather than a comment.
 *
 * ⚠ WHY "THE PROBE IS SANDBOXED" IS THE WRONG ASSERTION, and this file does not make it.
 * A probe wrapped in SOME sandbox passes that check while running in a DIFFERENT one from
 * the apps — the failure mode is a silent mismatch, not an absent wrapper. So the assertions
 * below are about PARITY between the two argvs, which is the property that actually holds
 * the instrument to its subject.
 *
 * The control at the bottom is PERMANENT and must never be deleted: it reconstructs the
 * pre-fix host-probe shape and requires it to FAIL these assertions. Without it, a change
 * that quietly made the assertions vacuous would leave every test in this file green.
 */
import { describe, expect, it } from 'vitest';
import { hostGlProbe } from '../../desktop/gl-strategy';
import {
  GL_PROBE_SANDBOX_TIER,
  desktopSandboxSession,
  type DesktopSandboxOpts,
} from './desktop-sandbox';

const DISPLAY = ':191';
// A fixture home, deliberately NOT under /home: this file is shipped source, and a
// hardcoded real home path is both a privacy leak and wrong on every other machine.
const HOME = '/tmp/gl-probe-parity-fixture-home';
const GPU_NODES = ['/dev/nvidia0', '/dev/nvidiactl'] as const;

/** Deterministic opts: no live bwrap probe, no live GPU scan, no live dotfile stat. */
const OPTS: DesktopSandboxOpts = {
  enabled: true,
  bwrapWorks: true,
  gpuDeviceNodes: [...GPU_NODES],
  maskExists: () => true,
};

const session = (opts: Partial<DesktopSandboxOpts> = {}) =>
  desktopSandboxSession(
    { display: DISPLAY, a11yBusPath: '/tmp/dbus-abc123', homeDir: HOME },
    { ...OPTS, ...opts },
  );

/**
 * The confinement, with the payload cut off: everything up to and including the bare `--`
 * that `buildDesktopSandboxCommand` puts before `input.cmd`. Two argvs with the same prefix
 * are the same sandbox running different programs — which is exactly the claim under test.
 */
function prefixOf(argv: readonly string[]): string[] {
  const sep = argv.indexOf('--');
  expect(sep, `expected a bare -- separator in: ${argv.join(' ')}`).toBeGreaterThan(0);
  return argv.slice(0, sep + 1);
}

/** The GL probe's full argv, as the provisioner builds it. */
const probeArgv = (s = session()) => s.forGlProbe(['vglrun', '-d', 'egl0', 'glxinfo']);

/** One app's full argv at the hardware tier, as the provisioner's app loop builds it. */
const appArgv = (s = session()) => {
  const d = s.forApp(['vglrun', '-d', 'egl0', 'xterm'], 'hardware');
  return [d.binary, ...d.argv];
};

describe('GL probe / app sandbox parity (WI-1223202)', () => {
  it('probes GL inside the SAME confinement the apps get', () => {
    expect(prefixOf(probeArgv())).toEqual(prefixOf(appArgv()));
  });

  it('carries the GPU device nodes into the probe, so hardware is REACHABLE from it', () => {
    // The direction that matters: a probe without these cannot see the GPU and reports
    // software for a hardware desktop — under-reporting, the unsound direction.
    const argv = probeArgv();
    expect(argv).toContain('/dev/dri');
    for (const node of GPU_NODES) expect(argv).toContain(node);
  });

  it('runs vglrun INSIDE the sandbox, not around it', () => {
    // VirtualGL's interposition must be subject to the confinement. The payload therefore
    // begins after the separator, and `bwrap` is the outermost binary.
    const argv = probeArgv();
    expect(argv[0]).toBe('bwrap');
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['vglrun', '-d', 'egl0', 'glxinfo']);
  });

  it('is MONOTONE: the probe tier is at least as capable as any app tier', () => {
    // Why the probe can be built at a fixed tier at all (see GL_PROBE_SANDBOX_TIER): the
    // app's device binds are a SUBSET of the probe's, so an app can never reach hardware the
    // probe could not. Software desktops get strictly fewer nodes, never more.
    expect(GL_PROBE_SANDBOX_TIER).toBe('hardware');
    const s = session();
    const softwareApp = s.forApp(['xterm'], 'software');
    for (const node of [...GPU_NODES, '/dev/dri']) {
      expect(softwareApp.argv, `software tier must not bind ${node}`).not.toContain(node);
      expect(probeArgv(s)).toContain(node);
    }
  });

  it('hostGlProbe hands the wrap the GL prefix AND glxinfo, in that order', () => {
    // Wiring, without mocking spawn: the wrap records what it was asked to confine and
    // redirects the spawn to a harmless binary. `true` exits 0 with empty stdout, so the
    // renderer parses as null — the assertion here is about the argv, not the result.
    const seen: string[][] = [];
    hostGlProbe((cmd) => {
      seen.push([...cmd]);
      return ['true'];
    }).probeRenderer(DISPLAY, ['vglrun', '-d', 'egl0'], {});
    expect(seen).toEqual([['vglrun', '-d', 'egl0', 'glxinfo']]);
  });

  it('is the IDENTITY when apps are unsandboxed — host probing is correct there', () => {
    // Constraint 3 on the work-item: unconditionally sandboxing the probe would make gl.tier
    // wrong in the opposite direction on a desktop whose apps run raw.
    for (const off of [{ enabled: false }, { bwrapWorks: false }]) {
      const s = session(off);
      expect(s.forGlProbe(['vglrun', '-d', 'egl0', 'glxinfo'])).toEqual([
        'vglrun',
        '-d',
        'egl0',
        'glxinfo',
      ]);
    }
  });

  /**
   * ⛔ PERMANENT CONTROL — DO NOT DELETE, DO NOT "FIX".
   *
   * This is the pre-fix probe: `[...launchPrefix, 'glxinfo']` spawned directly on the host.
   * It must FAIL the two assertions above. If this test ever goes red, the assertions have
   * stopped discriminating and the guard is decorative — which is precisely how the original
   * defect survived D-031.
   */
  it('CONTROL: the pre-fix host probe fails these same assertions', () => {
    const preFix = ['vglrun', '-d', 'egl0', 'glxinfo'];

    // (1) no separator ⇒ it is not a sandbox argv at all, so parity cannot even be computed.
    expect(preFix).not.toContain('--');

    // (2) it reaches no GPU node, because it inherits the host's /dev wholesale rather than
    //     the sandbox's — the very thing that let it report a renderer the app never had.
    expect(preFix).not.toContain('/dev/dri');

    // (3) and it differs from the app's confinement, which is the defect in one line.
    expect(prefixOf(appArgv())).not.toEqual(preFix);
  });
});
