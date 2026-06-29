/**
 * Recurrence guard for WI-934 (omp-account-pinning-gateway-2026-06-29 D-006):
 * headless `omp -p` once crashed at BOOT with
 *   "Cannot find package 'proxy-agent' from @puppeteer/browsers/lib/esm/httpUtil.js"
 * because `@puppeteer/browsers` eagerly imported `proxy-agent` and the install did
 * not hoist it to the top level. Resolved by the omp 16.2.5 upgrade (@puppeteer/
 * browsers 3.0.5 — proxy-agent is now an OPTIONAL peer, not eagerly imported, and is
 * hoisted as a real top-level dep). This smoke re-asserts the boot is clean.
 *
 * It is the DETECTOR the original incident lacked — the crash was only ever caught by
 * an agent manually running `omp -p`. CI has no `omp` binary, so this SELF-SKIPS there;
 * on a dev / release box (where the bug actually manifests — incl. the release
 * node_modules swap) it boots omp headless and fails if the proxy-agent crash regresses.
 *
 * Quota-safe: it boots against a FRESH EMPTY HOME (no ~/.omp auth/models.yml), so omp
 * loads its full module graph — including the `@puppeteer/browsers` httpUtil import, the
 * crash site — then fails on missing config/auth WITHOUT any real model call. The boot
 * crash, if it regressed, exits with the proxy-agent message before any of that.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Is the `omp` binary on PATH? `omp --version` is a non-headless, config-free probe. */
function ompOnPath(): boolean {
  try {
    const r = spawnSync('omp', ['--version'], { encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 && /\d+\.\d+\.\d+/.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  } catch {
    return false;
  }
}

const OMP_PRESENT = ompOnPath();

describe('omp headless boot — proxy-agent regression guard (WI-934)', () => {
  it.skipIf(!OMP_PRESENT)(
    'omp -p boots without the @puppeteer/browsers proxy-agent import crash',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'omp-boot-smoke-'));
      try {
        const r = spawnSync('omp', ['-p', 'ping'], {
          encoding: 'utf8',
          timeout: 25_000,
          // Isolated empty HOME: no creds ⇒ no real model call (quota-safe); omp still
          // loads its whole boot module graph (the proxy-agent crash site) before failing
          // on missing config. USERPROFILE covers the Windows homedir() resolution.
          env: { ...process.env, HOME: home, USERPROFILE: home },
        });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        // The regression signature — a boot-time module-resolution crash.
        expect(out).not.toMatch(/Cannot find package ['"]proxy-agent['"]/);
        expect(out).not.toMatch(/proxy-agent[\s\S]{0,80}httpUtil/);
      } finally {
        try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  );
});
