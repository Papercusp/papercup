/**
 * EI-19407722209410974 — the recurrence guard for the defect that survived its
 * own fix.
 *
 * EI-19385011811175105: an operator started by `npm run dev` from a
 * gnome-terminal tab carries that tab's `GNOME_TERMINAL_SCREEN`. Handed to a new
 * `gnome-terminal`, it asks the D-Bus factory for a screen that is long gone,
 * prints "Failed to get screen from object path ...", and EXITS 0 having opened
 * NO window — a zero-window launch reported as success. That fix landed in
 * `terminal-spawn.ts`... and missed `console-spawn.ts`, which keeps its OWN
 * LINUX_TERMINALS table, its own findTerminal and its own spawn, and which
 * serves the busier callers (capability:terminal, and every VISIBLE
 * fleet:launch-on-plan member).
 *
 * ── Why this is a SOURCE-LEVEL test and not a behavioural one ────────────────
 * The failure mode is not "the existing spawner regressed" — it is "somebody
 * added ANOTHER spawner and did not know this rule existed". A behavioural test
 * can only cover the call sites it already knows about, which is precisely the
 * blind spot that let this bug survive a fix aimed directly at it. Scanning the
 * source catches the fourth spawner the day it is written, before anyone has to
 * rediscover the D-Bus error message.
 *
 * The rule: in these files, a spawned child's env may never be built from a bare
 * `...process.env` spread. It must go through `scrubTerminalContextEnv`, which
 * drops the terminal/multiplexer identity of whatever tab THIS process was
 * started in.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERMINAL_CONTEXT_ENV_KEYS, scrubTerminalContextEnv } from './terminal-spawn';

const FILES = ['console-spawn.ts', 'terminal-spawn.ts'] as const;

function source(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8');
}

/**
 * Matches an object literal that spreads process.env INSIDE a
 * scrubTerminalContextEnv(...) call. `[^}]*` is safe here because none of these
 * literals contain a nested brace — if one ever does, this test fails loudly
 * (the spread reads as unscrubbed) rather than silently passing, which is the
 * correct direction for a guard.
 */
const SCRUBBED = /scrubTerminalContextEnv\(\{[^}]*\.\.\.process\.env/g;
const ANY_SPREAD = /\.\.\.process\.env/g;

describe('spawned-child env scrub (EI-19407722209410974)', () => {
  for (const file of FILES) {
    it(`${file}: every ...process.env spread is wrapped in scrubTerminalContextEnv`, () => {
      const src = source(file);
      const total = src.match(ANY_SPREAD)?.length ?? 0;
      const scrubbed = src.match(SCRUBBED)?.length ?? 0;
      expect(
        scrubbed,
        `${file} spreads process.env ${total}× but only ${scrubbed}× through ` +
          `scrubTerminalContextEnv. A spawned terminal must not inherit this ` +
          `process's terminal identity — see EI-19385011811175105.`,
      ).toBe(total);
    });

    it(`${file}: no spawn passes a bare process.env spread as its env`, () => {
      // The specific shape the bug had, pinned separately so the failure message
      // names the actual mistake rather than a count mismatch.
      expect(source(file)).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/);
    });
  }

  it('console-spawn.ts actually imports the scrub rather than re-implementing it', () => {
    // A local re-implementation would satisfy the regexes above while drifting
    // from TERMINAL_CONTEXT_ENV_KEYS — which is the whole failure mode this
    // family of bugs is made of.
    expect(source('console-spawn.ts')).toMatch(
      /import\s*\{[^}]*scrubTerminalContextEnv[^}]*\}\s*from\s*'\.\/terminal-spawn'/,
    );
  });

  it('the scrub removes the var that caused the zero-window launch', () => {
    // Ties the source-level rule to the concrete behaviour it protects, so this
    // file still fails if the key set is gutted while the call sites stay.
    const out = scrubTerminalContextEnv({
      PATH: '/usr/bin',
      DISPLAY: ':1',
      GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/f7136bff_f487_4330_8ff5_966041ee694a',
    });
    expect(out.GNOME_TERMINAL_SCREEN).toBeUndefined();
    expect(out.DISPLAY).toBe(':1');
    expect(TERMINAL_CONTEXT_ENV_KEYS).toContain('GNOME_TERMINAL_SCREEN');
  });

  it('the scrub removes operator-only sidecar toggles before launching agents', () => {
    // These flags tune git offload inside the operator service itself. If they
    // cross the operator→agent boundary, an unrelated agent-shell test can
    // route through the degraded spawner sidecar and emit a console warning
    // (WI-37487). Keep the assertion on the shared scrub, not one caller, so
    // visible, macOS, and headless spawn paths all inherit the same guard.
    const out = scrubTerminalContextEnv({
      PATH: '/usr/bin',
      PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR: '1',
      PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR: '1',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170',
    });
    expect(out.PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR).toBeUndefined();
    expect(out.PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR).toBeUndefined();
    expect(out.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:3170');
    expect(TERMINAL_CONTEXT_ENV_KEYS).toEqual(
      expect.arrayContaining([
        'PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR',
        'PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR',
      ]),
    );
  });
});
