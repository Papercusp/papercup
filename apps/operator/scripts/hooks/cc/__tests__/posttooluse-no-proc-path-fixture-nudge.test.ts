import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  nudgeFor,
  isCandidateFile,
  findRepoRoot,
  formatNudge,
} from '../posttooluse-no-proc-path-fixture-nudge.mjs';
import * as detector from '../../../../../../scripts/check-no-proc-path-fixture.mjs';

const HOOK = join(__dirname, '..', 'posttooluse-no-proc-path-fixture-nudge.mjs');

/**
 * ⚠ Every banned literal in this file is built by CONCATENATION, never spelled out.
 *
 * The detector anchors on a quote immediately followed by the `/proc/` prefix and
 * treats a bare prefix (empty first segment) as legitimate, so `P + 'made-up'`
 * produces the offending string at RUNTIME while leaving none in this file's source.
 * That matters concretely: this test file is NOT on the detector's allowlist (only the
 * detector and its own unit test are), so spelling a fixture literally here would red
 * the very green-checkpoint leg this hook exists to prevent — the guard for the class
 * blocked by the guard for the class.
 */
const P = '/proc/';
const MADE_UP = `const p = '${P}definitely-not-real/x';\n`;
const REAL_ENTRY = `const p = '${P}self/status';\n`;
const PID_PATH = `const p = '${P}1234/cmdline';\n`;

const base = {
  exists: () => true,
  repoRoot: '/repo',
  sizeOf: () => 100,
  loadDetector: async () => detector,
};

describe('posttooluse-no-proc-path-fixture-nudge — fires', () => {
  it('reports a made-up /proc literal on an edited test file', async () => {
    const msg = await nudgeFor('/repo/packages/x/a.test.ts', { ...base, readFile: () => MADE_UP });
    expect(msg).toBeTypeOf('string');
    expect(msg).toMatch(/HANGS Node forever/);
    expect(msg).toContain('packages/x/a.test.ts');
  });

  it('points the author at the shared fixture rather than only complaining', async () => {
    const msg = await nudgeFor('/repo/packages/x/a.test.ts', { ...base, readFile: () => MADE_UP });
    expect(msg).toMatch(/unwritablePath/);
  });

  it('de-duplicates a literal repeated many times into one report line', async () => {
    const msg = (await nudgeFor('/repo/packages/x/a.test.ts', {
      ...base,
      readFile: () => MADE_UP.repeat(4),
    })) as string;
    const occurrences = msg.split('\n').filter((l) => l.trim().startsWith('→')).length;
    expect(occurrences).toBe(1);
  });
});

describe('posttooluse-no-proc-path-fixture-nudge — stays silent (false positives are the real cost)', () => {
  it('is silent on a REAL procfs entry', async () => {
    expect(await nudgeFor('/repo/packages/x/b.ts', { ...base, readFile: () => REAL_ENTRY })).toBeNull();
  });

  it('is silent on a literal pid path', async () => {
    expect(await nudgeFor('/repo/packages/x/c.ts', { ...base, readFile: () => PID_PATH })).toBeNull();
  });

  it('is silent on a clean file', async () => {
    expect(
      await nudgeFor('/repo/packages/x/d.ts', { ...base, readFile: () => 'export const a = 1;\n' }),
    ).toBeNull();
  });

  it('is silent when the literal appears only in a COMMENT warning about the trap', async () => {
    // Otherwise this hook could not be documented anywhere without nagging.
    const text = `// never use '${P}made-up-thing' as a fixture\nexport const a = 1;\n`;
    expect(await nudgeFor('/repo/packages/x/e.ts', { ...base, readFile: () => text })).toBeNull();
  });

  it("honours the detector's allowlist (the guard and its own test contain the form by construction)", async () => {
    expect(
      await nudgeFor('/repo/scripts/check-no-proc-path-fixture.mjs', { ...base, readFile: () => MADE_UP }),
    ).toBeNull();
  });

  it('skips a non-code path WITHOUT reading it', async () => {
    const msg = await nudgeFor('/repo/docs/readme.md', {
      ...base,
      readFile: () => {
        throw new Error('must not be called');
      },
    });
    expect(msg).toBeNull();
  });
});

describe('posttooluse-no-proc-path-fixture-nudge — fails open (a guard bug must never disturb a successful edit)', () => {
  it('is silent outside any repo carrying the detector', async () => {
    const msg = await nudgeFor('/elsewhere/a.ts', {
      ...base,
      repoRoot: null,
      exists: () => false,
      readFile: () => {
        throw new Error('must not be called');
      },
    });
    expect(msg).toBeNull();
  });

  it('fails open on an unreadable file', async () => {
    const msg = await nudgeFor('/repo/packages/x/gone.ts', {
      ...base,
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(msg).toBeNull();
  });

  it('fails open when the detector cannot be loaded', async () => {
    const msg = await nudgeFor('/repo/packages/x/a.ts', {
      ...base,
      readFile: () => MADE_UP,
      loadDetector: async () => null,
    });
    expect(msg).toBeNull();
  });

  it('skips an oversized file without reading it', async () => {
    const msg = await nudgeFor('/repo/packages/x/huge.ts', {
      ...base,
      sizeOf: () => 2_000_001,
      readFile: () => {
        throw new Error('must not be called');
      },
    });
    expect(msg).toBeNull();
  });
});

describe('helpers', () => {
  it('treats the file types the gate scan covers as candidates', () => {
    for (const f of ['a.ts', 'a.tsx', 'a.mjs', 'a.cjs', 'a.js', 'a.jsx']) {
      expect(isCandidateFile(f), f).toBe(true);
    }
    for (const f of ['a.md', 'a.json', 'a.sh', 'a.py']) {
      expect(isCandidateFile(f), f).toBe(false);
    }
  });

  it('resolves the real repo root from this test file (no hardcoded path)', () => {
    const root = findRepoRoot(__filename);
    expect(root).toBeTypeOf('string');
    expect(detector.findProcFixtureOffenders).toBeTypeOf('function');
  });

  it('formatNudge names every distinct offender it is given', () => {
    const msg = formatNudge('pkg/a.ts', [{ literal: `${P}alpha` }, { literal: `${P}beta` }]);
    expect(msg).toContain('alpha');
    expect(msg).toContain('beta');
  });
});

/**
 * CALIBRATION — without this, every "stays silent" assertion above would also pass if
 * the imported detector were a no-op or if the fixtures were malformed. These prove the
 * inputs are real and the detector discriminates, so the silences above mean something.
 */
describe('calibration: the fixtures and the imported detector are real', () => {
  it('the detector flags the made-up literal', () => {
    expect(detector.findProcFixtureOffenders(MADE_UP).length).toBeGreaterThan(0);
  });

  it('the detector allows a real procfs entry and a pid path', () => {
    expect(detector.findProcFixtureOffenders(REAL_ENTRY)).toEqual([]);
    expect(detector.findProcFixtureOffenders(PID_PATH)).toEqual([]);
  });

  it('this hook is registered in the installer, so it actually ships', () => {
    // The hook file existing is not the same as it being installed — CC_HOOK_FILES is
    // what copies it to ~/.papercusp/hooks/cc and merges it into settings.json.
    const installer = join(__dirname, '..', '..', '..', '..', '..', '..',
      'packages', 'operator-core', 'lib', 'desktop-install', 'papercusp-files.ts');
    const src = execFileSync('cat', [installer], { encoding: 'utf8' });
    expect(src).toContain("'posttooluse-no-proc-path-fixture-nudge.mjs'");
    expect(src).toMatch(/matcher: 'Edit\|Write\|MultiEdit'/);
  });
});

describe('embedded self-test', () => {
  it('the shipped --self-test passes (the hook is executable and self-consistent)', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8', timeout: 60_000 });
    expect(out).toMatch(/all cases passed/);
  });
});
