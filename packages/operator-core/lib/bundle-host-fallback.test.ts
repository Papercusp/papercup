/**
 * EI-20093985382484201 — a broken shared tree must not take the service DOWN.
 *
 * `papercup-{staging,bg-host,dev}-api` run `bundle-host.sh` in ExecStartPre
 * against the LIVE shared working tree. Many agents edit that tree
 * continuously, so it is INVALID for the seconds between two keystrokes of any
 * multi-part edit. Before the fallback this guard covers, that transient state
 * was a fleet-wide outage: ExecStartPre exited non-zero, systemd refused to
 * start the unit, and Restart=always + RestartSec=5 re-bundled the same broken
 * tree every 5s at ~14s CPU a go.
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
const SCRIPT = join(REPO_ROOT, 'apps/operator/bin/bundle-host.sh');

/** The last-known-good bundle's exact bytes — the thing that must survive. */
const GOOD_BUNDLE = 'console.log("last known good");\n';

let dir: string;
let outfile: string;
let marker: string;

/** Run bundle-host.sh, returning its exit code and combined output. */
function runBundler(entry: string): { code: number; output: string } {
  try {
    const output = execFileSync('bash', [SCRIPT, entry, outfile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
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
    'STARTS on the previous bundle when the tree is momentarily broken, and says so loudly',
    () => {
      // A service that was serving fine a moment ago.
      execFileSync('mkdir', ['-p', join(dir, 'dist-host')], { timeout: 10_000, killSignal: 'SIGKILL' });
      writeFileSync(outfile, GOOD_BUNDLE);

      const { code, output } = runBundler(writeBrokenEntry());

      // THE POINT: ExecStartPre succeeds, so systemd starts the unit.
      expect(code).toBe(0);

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
    },
    260_000,
  );
});
