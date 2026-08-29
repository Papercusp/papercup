/**
 * P-012 — the retired capacity ENV readback.
 *
 * The load-bearing test here is not "does it print a warning"; it is the DERIVATION guard at the
 * bottom. RETIRED_CAPACITY_ENV_VARS is a hand-written constant, and a hand-written list that
 * describes code is exactly the thing that rots silently (derived-truth ladder). These tests pin it
 * from both sides: every entry must still be a legacy field the census knows about, and every entry
 * must still be read by NOTHING. If someone reintroduces a read of a "retired" variable, or the
 * census drops one, the guard fails instead of the fleet quietly regaining a ceiling.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RETIRED_CAPACITY_ENV_VARS,
  censusLegacyEnvNames,
  detectRetiredCapacityEnv,
  reportRetiredCapacityEnv,
} from './retired-capacity-env';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-host' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.(ts|mts|mjs)$/.test(entry) && !/\.test\.(ts|mts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('retired capacity env readback (P-012)', () => {
  it('warns loudly, and actionably, when a retired input is set', () => {
    const lines: string[] = [];
    const findings = reportRetiredCapacityEnv((_lvl, m) => lines.push(m), {
      PAPERCUSP_GATEWAY_CONCURRENCY: '24',
    } as NodeJS.ProcessEnv);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.name).toBe('PAPERCUSP_GATEWAY_CONCURRENCY');
    expect(findings[0]?.value).toBe('24');
    expect(lines).toHaveLength(1);
    // The three things a confused operator needs: that it does nothing, what governs it instead,
    // and that removing it is the fix. Assert the SUBSTANCE, not the exact prose.
    expect(lines[0]).toContain('PAPERCUSP_GATEWAY_CONCURRENCY=24');
    expect(lines[0]).toContain('NO EFFECT');
    expect(lines[0]).toMatch(/learned per provider lane/i);
    expect(lines[0]).toMatch(/remove it/i);
  });

  it('reports every retired input that is set, not just the first', () => {
    const findings = detectRetiredCapacityEnv({
      PAPERCUSP_GATEWAY_CONCURRENCY: '24',
      PAPERCUSP_GATEWAY_CODEX_CONCURRENCY: '8',
    } as NodeJS.ProcessEnv);
    expect(findings.map((f) => f.name).sort()).toEqual([
      'PAPERCUSP_GATEWAY_CODEX_CONCURRENCY',
      'PAPERCUSP_GATEWAY_CONCURRENCY',
    ]);
  });

  it('stays SILENT when nothing retired is set — a warning nobody needs trains operators to ignore it', () => {
    const lines: string[] = [];
    const findings = reportRetiredCapacityEnv((_lvl, m) => lines.push(m), {
      PAPERCUSP_GATEWAY_PORT: '8788',
    } as NodeJS.ProcessEnv);
    expect(findings).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('treats an empty or whitespace value as ABSENT (`Environment="FOO="` means unconfigured)', () => {
    expect(
      detectRetiredCapacityEnv({
        PAPERCUSP_GATEWAY_CONCURRENCY: '',
        PAPERCUSP_GATEWAY_CODEX_CONCURRENCY: '   ',
      } as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  // ── derivation guards: these are why the hand-written list is allowed to exist ──

  it('every retired entry is a legacy field the capacity census still knows about', () => {
    const census = censusLegacyEnvNames();
    for (const retired of RETIRED_CAPACITY_ENV_VARS) {
      expect(census, `${retired.name} is not in any compatibility group's legacyFields`).toContain(retired.name);
    }
  });

  it('every retired entry is read by NOTHING in live source — the recurrence guard', () => {
    const files = [
      ...collectSourceFiles(join(REPO_ROOT, 'packages', 'operator-core', 'lib')),
      ...collectSourceFiles(join(REPO_ROOT, 'libs', 'papercusp-shared', 'src')),
    ];
    // Positive control: the scan must be capable of finding a read at all, otherwise an empty or
    // mis-rooted file list would make this test pass vacuously — the exact way a guard lies.
    const anyKnownRead = files.some((f) =>
      readFileSync(f, 'utf8').includes('process.env.PAPERCUSP_GATEWAY_MAX_QUEUED'),
    );
    expect(anyKnownRead, 'scan found no known live env read — the file scan is broken, not the code').toBe(true);

    for (const retired of RETIRED_CAPACITY_ENV_VARS) {
      const readers = files.filter((f) => {
        const src = readFileSync(f, 'utf8');
        return (
          src.includes(`process.env.${retired.name}`) || src.includes(`process.env['${retired.name}']`)
        );
      });
      expect(
        readers.map((f) => f.slice(REPO_ROOT.length + 1)),
        `${retired.name} is declared RETIRED but is being read again`,
      ).toEqual([]);
    }
  });

  it('the systemd unit tombstones the variable instead of suggesting a value for it', () => {
    const unit = readFileSync(
      join(REPO_ROOT, 'apps', 'operator', 'scripts', 'systemd', 'papercup-inference-gateway.service'),
      'utf8',
    );
    expect(unit).toContain('# RETIRED: PAPERCUSP_GATEWAY_CONCURRENCY is read by nothing');
    // The precise regression P-012 exists to prevent: a commented-out assignment reads as a
    // supported knob with a recommended value, which is a capacity CLAIM a deployer will act on.
    expect(unit).not.toMatch(/^\s*#\s*Optional:\s*PAPERCUSP_GATEWAY_CONCURRENCY\s*=/m);
    expect(unit).not.toMatch(/^\s*Environment=.*PAPERCUSP_GATEWAY_CONCURRENCY/m);
  });

  it('startGatewayService performs the readback on the shared deployment entry point', () => {
    // A behavioural test would have to stand up the whole gateway (ports, credentials, pools), so
    // this asserts the WIRING at the one place every deployment path passes through. Narrow on
    // purpose: it fails if the call is deleted, which is the regression that matters.
    const launch = readFileSync(join(__dirname, 'launch.ts'), 'utf8');
    expect(launch).toContain('reportRetiredCapacityEnv(log, opts.env ?? process.env)');
  });
});
