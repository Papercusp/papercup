/**
 * EI-20093985382484201 / WI-41242 — a broken shared tree must fail loudly
 * without corrupting the last-known-good bundle.
 *
 * `papercup-{staging,bg-host,dev}-api` run `bundle-host.sh` in ExecStartPre.
 * Shared-tree callers can observe the seconds between two keystrokes of a
 * multi-part edit; staging instead uses a clean isolated checkout and may reuse
 * a separately proven prebuild. In every case the fallback keeps prior bytes
 * intact, while WI-41242 makes a release caller fail loudly rather than report
 * stale code as current.
 *
 * EI-19457229906581679: "deploy/systemd" in the line above used to be one
 * clause, and that conflation was the defect. A non-zero exit stops deploy-cli
 * from REPORTING a release (correct) but stops systemd from STARTING THE UNIT
 * (an outage) — opposite meanings for the same exit code. The caller now
 * declares which question it is asking via PAPERCUSP_BUNDLE_ALLOW_STALE_START;
 * the default is unchanged, so release callers are unaffected.
 *
 * Measured 2026-08-10: ONE unescaped apostrophe inside a tool `description:`
 * string took :3170 down fleet-wide for ~52s over 4 restarts — the SECOND such
 * outage that day, from a different typo by a different agent. The typo is
 * unremarkable and will recur; the outage is the defect. Filed at least three
 * times (EI-20093985382484201, EI-19457410012213374, EI-20086810553934720).
 *
 * ── Why this test can afford to run the real script ──
 * It drives bundle-host.sh with ABSOLUTE entry/outfile paths into a fresh
 * tmpdir, so every artifact it can write — the bundle, the tmp file, the lock,
 * the build log, the marker — lands outside the repo. That matters more than
 * usual here: proving a guard falsifiable by mutating the shared checkout is
 * how a mutant gets committed by the git-sync sweep mid-probe.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
// PROBE_SCRIPT makes the subject path overridable, which is what makes a TIER-2
// mutation probe (mutate a COPY outside the tree) possible at all. Without it the
// only way to prove these assertions falsifiable is to mutate the shared checkout
// — where the git-sync sweep can commit the mutant mid-probe even when nothing
// goes wrong and no handler fails. Defaults to the real script, so every normal
// run is unaffected.
const SCRIPT = process.env.PROBE_SCRIPT || join(REPO_ROOT, 'apps/operator/bin/bundle-host.sh');

/** The last-known-good bundle's exact bytes — the thing that must survive. */
const GOOD_BUNDLE = 'console.log("last known good");\n';

let dir: string;
let outfile: string;
let marker: string;

/** Run bundle-host.sh, returning its exit code and combined output. */
function runBundler(entry: string, extraEnv?: Record<string, string>): { code: number; output: string } {
  try {
    const output = execFileSync('bash', [SCRIPT, entry, outfile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
      // The strict release path is the default contract. Set it explicitly so
      // a supervisor-only opt-in inherited from the invoking agent/service
      // cannot silently change the first two cases into successful stale boots.
      env: { ...process.env, PAPERCUSP_BUNDLE_ALLOW_STALE_START: '0', ...extraEnv },
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function writeBrokenEntry(): string {
  const entry = join(dir, 'broken-entry.ts');
  // The REAL 2026-08-10 shape: an unescaped apostrophe closes the string early,
  // leaving the parser inside an object literal expecting `}` and finding `s`.
  writeFileSync(entry, "export const tool = { description: 'this install's root' };\n");
  return entry;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bundle-host-fallback-'));
  outfile = join(dir, 'dist-host', 'hono-host.mjs');
  marker = join(dir, 'dist-host', '.bundle-stale.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bundle-host.sh last-known-good fallback', () => {
  it('enters the install-safe mutex before resolving bundle dependencies', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const guardIdx = src.indexOf('--exec-under-lock');
    const commonInputsIdx = src.indexOf('source "$SCRIPT_DIR/bundle-host-common.sh"');
    const esbuildIdx = src.indexOf('npx --yes esbuild@0.25.0');

    expect(guardIdx).toBeGreaterThan(-1);
    expect(src).toContain('PAPERCUSP_INSTALL_MUTEX_HELD');
    expect(guardIdx).toBeLessThan(commonInputsIdx);
    expect(guardIdx).toBeLessThan(esbuildIdx);
  });

  it(
    'RETAINS the previous bundle when the tree is momentarily broken, but fails loudly',
    () => {
      // A service that was serving fine a moment ago.
      execFileSync('mkdir', ['-p', join(dir, 'dist-host')], { timeout: 10_000, killSignal: 'SIGKILL' });
      writeFileSync(outfile, GOOD_BUNDLE);

      const { code, output } = runBundler(writeBrokenEntry());

      // THE POINT: ExecStartPre fails, so systemd/deploy cannot report stale
      // code as a successful release.
      expect(code).not.toBe(0);

      // The bundle that was already on disk is untouched — this is what the
      // pre-existing atomic swap (EI-9413) buys us: esbuild writes a tmp file
      // and we rename it in, so a FAILED build cannot corrupt the good one.
      expect(readFileSync(outfile, 'utf8')).toBe(GOOD_BUNDLE);

      // ...and it is impossible to miss. A SILENTLY stale service is worse than
      // a down one: an agent verifies a fix against pre-fix code and believes it.
      expect(output).toMatch(/FALLING BACK/);
      expect(output).toMatch(/STALE CODE/);

      expect(existsSync(marker)).toBe(true);
      const parsed = JSON.parse(readFileSync(marker, 'utf8'));
      expect(parsed.schema).toBe('bundle-stale-v1');
      // Names the file to go fix, so nobody reconstructs it from the journal.
      expect(parsed.failingFiles.join('\n')).toMatch(/broken-entry\.ts:\d+:\d+/);
      expect(parsed.error).toMatch(/ERROR/);
      expect(parsed.servingBundleMtime).toBeTruthy();
    },
    260_000,
  );

  it(
    'still REFUSES to start when there is no previous bundle to fall back to',
    () => {
      // Nothing to serve: exec'ing a missing entrypoint would crash-loop anyway,
      // and a fallback is only correct when something exists to fall back to.
      const { code, output } = runBundler(writeBrokenEntry());

      expect(code).not.toBe(0);
      expect(output).toMatch(/NO previous bundle/);
      expect(existsSync(outfile)).toBe(false);
    },
    260_000,
  );

  // ── EI-19457229906581679: the SUPERVISOR caller ──────────────────────────
  // A systemd ExecStartPre asks "may the unit start?", not "did the requested
  // code build?". The two tests above pin the RELEASE answer (the default, and
  // unchanged). These pin the supervisor answer, which the same exit code had
  // been silently denying: measured 2026-08-27, a bundle failed at 10:47:11Z
  // with a good bundle on disk and :3170 still died into its start-limit.
  it(
    'lets a SUPERVISOR boot on the last-known-good bundle when it opts in',
    () => {
      execFileSync('mkdir', ['-p', join(dir, 'dist-host')], { timeout: 10_000, killSignal: 'SIGKILL' });
      writeFileSync(outfile, GOOD_BUNDLE);

      const { code, output } = runBundler(writeBrokenEntry(), {
        PAPERCUSP_BUNDLE_ALLOW_STALE_START: '1',
      });

      // THE POINT: the unit starts instead of crash-looping every RestartSec=5.
      expect(code).toBe(0);

      // Availability is bought WITHOUT giving up any of the loudness. Silence
      // here would be the worse failure: an agent verifying a fix against
      // pre-fix code and believing it.
      expect(readFileSync(outfile, 'utf8')).toBe(GOOD_BUNDLE);
      expect(output).toMatch(/FALLING BACK/);
      expect(output).toMatch(/STALE CODE/);
      expect(existsSync(marker)).toBe(true);
    },
    260_000,
  );

  it(
    'REFUSES to start even for an opted-in supervisor when no bundle exists',
    () => {
      // The opt-in trades freshness for availability; it must never license
      // exec'ing an entrypoint that is not there. This is exactly why the fix
      // is an env var and not `ExecStartPre=-` in the drop-in: the `-` prefix
      // ignores ALL failures, so this branch would proceed to a MODULE_NOT_FOUND
      // crash-loop instead of refusing cleanly with a diagnosis.
      const { code, output } = runBundler(writeBrokenEntry(), {
        PAPERCUSP_BUNDLE_ALLOW_STALE_START: '1',
      });

      expect(code).not.toBe(0);
      expect(output).toMatch(/NO previous bundle/);
      expect(existsSync(outfile)).toBe(false);
    },
    260_000,
  );

  it(
    'CLEARS the marker once the tree builds again',
    () => {
      // Without this the marker would latch: /api/health would keep reporting a
      // long-fixed staleness, which trains readers to ignore it — the failure
      // mode that makes a warning worse than no warning at all.
      execFileSync('mkdir', ['-p', join(dir, 'dist-host')], { timeout: 10_000, killSignal: 'SIGKILL' });
      writeFileSync(outfile, GOOD_BUNDLE);
      writeFileSync(marker, JSON.stringify({ schema: 'bundle-stale-v1', outfile }));

      const entry = join(dir, 'fine-entry.ts');
      writeFileSync(entry, 'export const ok = 1;\nconsole.log(ok);\n');

      const { code, output } = runBundler(entry);

      expect(code).toBe(0);
      expect(output).toMatch(/✓ bundled/);
      expect(existsSync(marker)).toBe(false);
      // The good bundle was genuinely replaced, not merely left alone.
      expect(readFileSync(outfile, 'utf8')).not.toBe(GOOD_BUNDLE);
      // Generated output carries the marker consumed by content-lint's
      // generated-file exemption; future banner changes must preserve it.
      // The banner is ASCII-only ON PURPOSE (a plain hyphen, not an em dash):
      // bundle-host.sh runs ascii-escape-bundle.mjs over the finished bundle
      // (WI-38221 widen-avoidance), which rewrites every non-ASCII char as a
      // \uXXXX escape — a non-ASCII banner therefore (a) guaranteed the pass had
      // ≥1 hit on EVERY bundle and (b) came out as `—` on disk, which is
      // what this assertion caught red on the frozen candidate (WI-2141194 #6b).
      expect(readFileSync(outfile, 'utf8')).toMatch(
        /^\/\* @generated by apps\/operator\/bin\/bundle-host\.sh - do not edit \*\//,
      );
    },
    260_000,
  );
});
