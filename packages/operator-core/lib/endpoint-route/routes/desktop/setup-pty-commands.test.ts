import { describe, expect, it } from 'vitest';
import { buildFrameworkInstallSpec, buildInstallSpec } from './setup-pty-commands';

const HOME = '/home/tester';

describe('buildFrameworkInstallSpec', () => {
  it('claude on linux curls the official installer', () => {
    const spec = buildFrameworkInstallSpec('claude', 'linux', HOME);
    expect(spec.command).toBe('bash');
    const script = spec.args.join(' ');
    expect(script).toContain('https://claude.ai/install.sh');
    // Only the chosen framework — no meridian/codex spill-over.
    expect(script).not.toContain('@rynfar/meridian');
    expect(script).not.toContain('@openai/codex');
  });

  it('codex on linux installs @openai/codex into the shared runtime prefix', () => {
    const spec = buildFrameworkInstallSpec('codex', 'linux', HOME);
    const script = spec.args.join(' ');
    expect(script).toContain('npm install --prefix ~/.papercusp/runtime');
    expect(script).toContain('@openai/codex@latest');
    expect(script).not.toContain('claude.ai/install');
  });

  it('omp-meridian on linux installs pinned meridian and notes bundled omp', () => {
    const spec = buildFrameworkInstallSpec('omp-meridian', 'darwin', HOME);
    const script = spec.args.join(' ');
    expect(script).toMatch(/@rynfar\/meridian@\d+\.\d+\.\d+/);
    expect(script).toContain('bundled with the desktop app');
    expect(script).not.toContain('@openai/codex');
  });

  it('runtime installs bootstrap a package.json so npm --prefix behaves', () => {
    for (const framework of ['codex', 'omp-meridian'] as const) {
      const script = buildFrameworkInstallSpec(framework, 'linux', HOME).args.join(' ');
      expect(script).toContain('npm init -y');
    }
  });

  it('win32 uses powershell for claude and codex', () => {
    for (const framework of ['claude', 'codex'] as const) {
      const spec = buildFrameworkInstallSpec(framework, 'win32', HOME);
      expect(spec.command).toBe('powershell.exe');
    }
    expect(buildFrameworkInstallSpec('claude', 'win32', HOME).args.join(' ')).toContain(
      'https://claude.ai/install.ps1',
    );
    expect(buildFrameworkInstallSpec('codex', 'win32', HOME).args.join(' ')).toContain(
      '@openai/codex@latest',
    );
  });

  it('omp-meridian on win32 throws loudly (D-006: Windows v1 ships no omp)', () => {
    expect(() => buildFrameworkInstallSpec('omp-meridian', 'win32', HOME)).toThrow(/Windows/);
  });
});

describe('buildInstallSpec (wizard all-in-one, unchanged contract)', () => {
  it('still installs the full runtime on linux', () => {
    const script = buildInstallSpec('linux', HOME).args.join(' ');
    expect(script).toContain('claude.ai/install.sh');
    expect(script).toContain('@rynfar/meridian');
    expect(script).toContain('@openai/codex');
  });
});
