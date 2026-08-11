/**
 * psu-launcher-backend-detect.test.ts (WI-37920) — recurrence guard for the class
 * "a backend CLI that IS installed is reported as `not installed`, but only inside a
 * desktop-spawned terminal".
 *
 * The failure this pins:
 *   - `omp` is installed by bun into ~/.bun/bin.
 *   - ~/.bun/bin reaches PATH via ~/.bashrc, BELOW the standard
 *     "If not running interactively, don't do anything" early-return.
 *   - EVERY desktop spawn runs `bash -lc` (login, NON-interactive), so that block
 *     never executes; and gnome-terminal additionally hands the command to a
 *     long-lived gnome-terminal-server over D-Bus, which runs it under the DESKTOP
 *     session's env rather than the operator's (measured: its PATH had zero `.bun`
 *     entries while the operator's carried ~/.bun/bin).
 *   - So the PATH leg of detectBackendBin() misses, and the ONLY thing standing
 *     between the user and `psu: the omp backend (`omp`) is not installed.` is
 *     wellKnownBackendBin()'s fallback list.
 *
 * This is why the bug read as door-specific ("fleets work, launch-agent doesn't")
 * when it is actually BACKEND-specific: claude/codex resolve on the desktop PATH,
 * omp did not. Every door shares one spawn path (console-spawn's spawnConsole).
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-launcher-backend-detect.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { wellKnownBackendBin } from './psu-launcher.mjs';

/**
 * Install locations a backend can legitimately land in, that a desktop-spawned
 * (login, non-interactive) shell CANNOT be relied on to have on PATH. Adding a
 * backend or an installer means adding a row here — that is the point.
 */
const INSTALLER_LOCATIONS: ReadonlyArray<{ agent: string; installer: string; rel: string }> = [
  { agent: 'omp', installer: 'bun add -g', rel: '.bun/bin/omp' },
  { agent: 'omp', installer: 'papercusp setup', rel: '.papercusp/bin/omp' },
  { agent: 'claude', installer: 'native installer', rel: '.local/bin/claude' },
  { agent: 'codex', installer: 'npm -g', rel: '.npm-global/bin/codex' },
];

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'psu-backend-detect-'));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('wellKnownBackendBin — PATH-independent backend detection (WI-37920)', () => {
  it.each(INSTALLER_LOCATIONS)(
    'finds $agent installed by "$installer" at ~/$rel with NOTHING on PATH',
    ({ agent, rel }) => {
      const bin = join(home, rel);
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });

      // env deliberately carries an EMPTY PATH: this asserts the fallback list alone
      // is sufficient, which is exactly the situation inside a desktop terminal.
      const found = wellKnownBackendBin(agent, { home, env: { PATH: '' } });

      expect(
        found,
        `${agent} installed at ~/${rel} must be detectable without PATH — otherwise psu ` +
          `aborts with "the ${agent} backend is not installed" inside every desktop-spawned ` +
          `terminal, while the same binary works fine in the user's interactive shell.`,
      ).toBe(bin);
    },
  );

  it('returns null for a backend that genuinely is not installed', () => {
    const empty = mkdtempSync(join(tmpdir(), 'psu-backend-detect-empty-'));
    try {
      expect(wellKnownBackendBin('omp', { home: empty, env: { PATH: '' } })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
