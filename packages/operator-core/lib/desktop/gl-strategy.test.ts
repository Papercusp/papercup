/**
 * gl-strategy.test.ts — the GL ladder, and the guard that its TWO implementations agree.
 *
 * The interesting test here is the last describe block. `buildGlSelectScript` re-implements
 * `selectGlStrategy` in shell, because the frame bootstraps on a remote VM that cannot run
 * this TypeScript. Two implementations of one decision is exactly the drift the repo's
 * derive/pin/attest rule exists to stop, and a substring assertion ("the script mentions
 * vglrun") would NOT stop it: the shell could mention vglrun and still branch the other way.
 * So the script is EXECUTED against stub binaries, and its verdict is compared to the
 * TypeScript verdict for the SAME host facts. Divergence fails.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyGlStrategy,
  buildGlSelectScript,
  classifyGlRenderer,
  GL_APT_PACKAGES,
  type GlProbe,
  type GlStrategy,
  MESA_SOFTWARE_ENV,
  parseGlRenderer,
  selectGlStrategy,
  SOFTWARE_RENDERER_MARKERS,
  VIRTUALGL_ARGV,
} from './gl-strategy';

const DISPLAY = ':191';

/** A probe built from explicit host facts — the renderer each (prefix, forced-mesa) pair yields. */
function probeOf(facts: {
  vglrun?: boolean;
  renderNode?: boolean;
  /** renderer through `vglrun` */
  viaVirtualgl?: string | null;
  /** renderer with nothing forced */
  native?: string | null;
  /** renderer with MESA_SOFTWARE_ENV forced */
  forcedMesa?: string | null;
}): GlProbe {
  return {
    hasBinary: (name) => (name === 'vglrun' ? facts.vglrun === true : false),
    hasRenderNode: () => facts.renderNode === true,
    probeRenderer: (_display, launchPrefix, env) => {
      if (launchPrefix.length > 0) return facts.viaVirtualgl ?? null;
      if (Object.keys(env).length > 0) return facts.forcedMesa ?? null;
      return facts.native ?? null;
    },
  };
}

describe('classifyGlRenderer', () => {
  it('reads a GPU renderer as hardware', () => {
    expect(classifyGlRenderer('NVIDIA GeForce RTX 3090/PCIe/SSE2')).toBe('hardware');
    expect(classifyGlRenderer('AMD Radeon RX 7900 XTX (radeonsi)')).toBe('hardware');
  });

  it('reads every known software rasterizer as software', () => {
    // Driven off the exported list so a marker added to the constant cannot be forgotten here.
    for (const marker of SOFTWARE_RENDERER_MARKERS) {
      expect(classifyGlRenderer(`Mesa ${marker} thing (LLVM 20.1.2, 256 bits)`)).toBe('software');
    }
    // The exact string this box produced on a bare Xvfb (measured 2026-08-23).
    expect(classifyGlRenderer('llvmpipe (LLVM 20.1.2, 256 bits)')).toBe('software');
  });

  it('reads an absent renderer as none, never as an optimistic guess', () => {
    expect(classifyGlRenderer(null)).toBe('none');
    expect(classifyGlRenderer(undefined)).toBe('none');
    expect(classifyGlRenderer('')).toBe('none');
    expect(classifyGlRenderer('   ')).toBe('none');
  });
});

describe('parseGlRenderer', () => {
  it('finds the renderer amid the noise real glxinfo emits on a headless display', () => {
    // Verbatim shape of the measured output: extension lists and libEGL warnings around it.
    const output = [
      '    GLX_ARB_create_context_no_error, GLX_ARB_create_context_profile, ',
      'libEGL warning: DRI3 error: Could not get DRI3 device',
      'OpenGL renderer string: llvmpipe (LLVM 20.1.2, 256 bits)',
      '    GL_KHR_debug, GL_KHR_no_error, ',
    ].join('\n');
    expect(parseGlRenderer(output)).toBe('llvmpipe (LLVM 20.1.2, 256 bits)');
  });

  it('returns null when glxinfo produced no renderer line', () => {
    expect(parseGlRenderer('Error: unable to open display :191\n')).toBeNull();
  });
});

describe('selectGlStrategy — the ladder', () => {
  it('takes VirtualGL when it demonstrably reaches hardware', () => {
    const s = selectGlStrategy(
      DISPLAY,
      probeOf({ vglrun: true, renderNode: true, viaVirtualgl: 'NVIDIA GeForce RTX 3090/PCIe/SSE2' }),
    );
    expect(s.id).toBe('virtualgl');
    expect(s.tier).toBe('hardware');
    expect(s.launchPrefix).toEqual([...VIRTUALGL_ARGV]);
    expect(s.env).toEqual({});
  });

  it('REFUSES VirtualGL when the wrapper only reaches software, and does not claim hardware', () => {
    // The trap this rung exists for: vglrun and a render node both present, but the EGL
    // device is unusable (wrong group on renderD128, no NVIDIA EGL) so VGL silently falls
    // back to llvmpipe. Taking it here would record tier:'hardware' for a display with none.
    const s = selectGlStrategy(
      DISPLAY,
      probeOf({
        vglrun: true,
        renderNode: true,
        viaVirtualgl: 'llvmpipe (LLVM 20.1.2, 256 bits)',
        native: 'llvmpipe (LLVM 20.1.2, 256 bits)',
      }),
    );
    expect(s.id).toBe('mesa-software');
    expect(s.tier).toBe('software');
    expect(s.launchPrefix).toEqual([]);
  });

  it('skips VirtualGL entirely when there is no render node to route to', () => {
    const s = selectGlStrategy(
      DISPLAY,
      probeOf({ vglrun: true, renderNode: false, native: 'llvmpipe (LLVM 20.1.2, 256 bits)' }),
    );
    expect(s.id).toBe('mesa-software');
  });

  it('uses the native stack as-is when it already reaches hardware — never downgrades it', () => {
    // Forcing MESA_SOFTWARE_ENV here would swap a working GPU for llvmpipe.
    const s = selectGlStrategy(DISPLAY, probeOf({ native: 'NVIDIA GeForce RTX 3090/PCIe/SSE2' }));
    expect(s.id).toBe('native');
    expect(s.tier).toBe('hardware');
    expect(s.launchPrefix).toEqual([]);
    expect(s.env).toEqual({});
  });

  it('pins mesa on the GPU-less path (D-002/P-012: BYOC workspace VMs have no GPU)', () => {
    const s = selectGlStrategy(DISPLAY, probeOf({ native: 'llvmpipe (LLVM 20.1.2, 256 bits)' }));
    expect(s.id).toBe('mesa-software');
    expect(s.tier).toBe('software');
    expect(s.env).toEqual(MESA_SOFTWARE_ENV);
  });

  it('rescues a broken vendor dispatch: no default renderer, but forcing mesa produces one', () => {
    const s = selectGlStrategy(
      DISPLAY,
      probeOf({ native: null, forcedMesa: 'llvmpipe (LLVM 20.1.2, 256 bits)' }),
    );
    expect(s.id).toBe('mesa-software');
    expect(s.tier).toBe('software');
    expect(s.reason).toMatch(/forcing mesa recovered/i);
  });

  it('reports none — honestly — when nothing produces a renderer', () => {
    const s = selectGlStrategy(DISPLAY, probeOf({}));
    expect(s.id).toBe('none');
    expect(s.tier).toBe('none');
    expect(s.renderer).toBeNull();
  });
});

describe('applyGlStrategy', () => {
  it('layers env and wraps argv together, so a caller cannot apply one without the other', () => {
    const strategy: GlStrategy = {
      id: 'virtualgl',
      tier: 'hardware',
      launchPrefix: [...VIRTUALGL_ARGV],
      env: { FOO: 'bar' },
      reason: 'test',
      renderer: 'NVIDIA',
    };
    const { env, argv } = applyGlStrategy(strategy, { DISPLAY, PATH: '/usr/bin' }, ['xterm', '-e', 'top']);
    expect(argv).toEqual(['vglrun', '-d', 'egl0', 'xterm', '-e', 'top']);
    expect(env).toEqual({ DISPLAY, PATH: '/usr/bin', FOO: 'bar' });
  });

  it('leaves argv untouched for an env-only rung', () => {
    const strategy: GlStrategy = {
      id: 'mesa-software',
      tier: 'software',
      launchPrefix: [],
      env: MESA_SOFTWARE_ENV,
      reason: 'test',
      renderer: 'llvmpipe',
    };
    const { env, argv } = applyGlStrategy(strategy, { DISPLAY }, ['xterm']);
    expect(argv).toEqual(['xterm']);
    expect(env.LIBGL_ALWAYS_SOFTWARE).toBe('1');
    expect(env.__GLX_VENDOR_LIBRARY_NAME).toBe('mesa');
  });
});

/* ───────── the differential guard: the shell ladder must decide what the TS ladder decides ───────── */

const workRoots: string[] = [];
afterAll(() => {
  for (const dir of workRoots) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the emitted shell ladder against stub `glxinfo` / `vglrun` binaries and return the
 * tier it recorded, plus the env file it wrote.
 */
function runShellLadder(facts: {
  vglrun?: boolean;
  renderNode?: boolean;
  viaVirtualgl?: string | null;
  native?: string | null;
  forcedMesa?: string | null;
}): { tier: string; envFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'gl-ladder-'));
  workRoots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);

  // A render-node fixture the emitted `ls <glob>` can succeed or fail against, so rung 1 is
  // controllable without touching the host's real /dev/dri.
  const nodeDir = join(root, 'dri');
  mkdirSync(nodeDir);
  if (facts.renderNode) writeFileSync(join(nodeDir, 'renderD128'), '');

  const emit = (renderer: string | null | undefined) =>
    renderer ? `echo "OpenGL renderer string: ${renderer}"\n` : '';

  // The stub glxinfo answers differently depending on whether mesa was FORCED into its
  // environment — which is what lets the "forcing mesa rescued it" rung be exercised.
  writeFileSync(
    join(bin, 'glxinfo'),
    [
      '#!/usr/bin/env bash',
      `if [ "\${LIBGL_ALWAYS_SOFTWARE:-}" = "1" ] && [ "\${__GLX_VENDOR_LIBRARY_NAME:-}" = "mesa" ]; then`,
      emit(facts.forcedMesa).trim() || '  :',
      'else',
      emit(facts.native).trim() || '  :',
      'fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(join(bin, 'glxinfo'), 0o755);

  if (facts.vglrun) {
    // `vglrun -d egl0 glxinfo` → the renderer VGL resolves to, independent of the stub above.
    writeFileSync(
      join(bin, 'vglrun'),
      ['#!/usr/bin/env bash', emit(facts.viaVirtualgl).trim() || ':', 'exit 0'].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(join(bin, 'vglrun'), 0o755);
  }

  const envPath = join(root, 'gl-strategy.env');
  const script = [
    'set -u',
    'log() { :; }',
    buildGlSelectScript(DISPLAY, { envPath, renderNodeGlob: `${nodeDir}/renderD*` }),
  ].join('\n');

  execFileSync('bash', ['-c', script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });

  const envFile = readFileSync(envPath, 'utf8');
  const tier = /^export PAPERCUSP_GL_TIER=(\S+)$/m.exec(envFile)?.[1] ?? 'MISSING';
  return { tier, envFile };
}

describe('buildGlSelectScript — the shell ladder agrees with the TypeScript ladder', () => {
  // One row per rung. Each is run through BOTH implementations and their verdicts compared.
  const cases: Array<{ name: string; facts: Parameters<typeof runShellLadder>[0] }> = [
    {
      name: 'VirtualGL reaches hardware',
      facts: { vglrun: true, renderNode: true, viaVirtualgl: 'NVIDIA GeForce RTX 3090/PCIe/SSE2' },
    },
    {
      name: 'VirtualGL present but only reaches llvmpipe',
      facts: {
        vglrun: true,
        renderNode: true,
        viaVirtualgl: 'llvmpipe (LLVM 20.1.2, 256 bits)',
        native: 'llvmpipe (LLVM 20.1.2, 256 bits)',
      },
    },
    {
      name: 'no render node, software native',
      facts: { vglrun: true, renderNode: false, native: 'llvmpipe (LLVM 20.1.2, 256 bits)' },
    },
    { name: 'native hardware, no vglrun', facts: { native: 'NVIDIA GeForce RTX 3090/PCIe/SSE2' } },
    { name: 'GPU-less: native software', facts: { native: 'llvmpipe (LLVM 20.1.2, 256 bits)' } },
    {
      name: 'broken vendor dispatch, forcing mesa rescues it',
      facts: { native: null, forcedMesa: 'llvmpipe (LLVM 20.1.2, 256 bits)' },
    },
    { name: 'no GL at all', facts: {} },
  ];

  for (const { name, facts } of cases) {
    it(`agrees on: ${name}`, () => {
      const ts = selectGlStrategy(DISPLAY, probeOf(facts));
      const shell = runShellLadder(facts);
      expect(shell.tier, `shell tier disagreed with selectGlStrategy (${ts.id}/${ts.tier})`).toBe(ts.tier);

      // The wrapper must be carried across too, not just the tier.
      if (ts.id === 'virtualgl') {
        expect(shell.envFile).toContain(`export PAPERCUSP_GL_LAUNCH_PREFIX=${VIRTUALGL_ARGV.join(' ')}`);
      } else {
        expect(shell.envFile).not.toContain('PAPERCUSP_GL_LAUNCH_PREFIX');
      }

      // ...and so must the env, whenever the TS rung carries one.
      for (const [k, v] of Object.entries(ts.env)) {
        expect(shell.envFile).toContain(`export ${k}=${v}`);
      }
      if (Object.keys(ts.env).length === 0) {
        for (const k of Object.keys(MESA_SOFTWARE_ENV)) {
          expect(shell.envFile).not.toContain(`export ${k}=`);
        }
      }
    });
  }

  it('names the packages a GL-less host is missing, so the warning is actionable', () => {
    const script = buildGlSelectScript(':99');
    for (const pkg of GL_APT_PACKAGES) expect(script).toContain(pkg);
  });
});
