/**
 * psu-pty-turn-boundary-generalization-2026-09-22 P-006 — a ROUTINE defer diagnostic must
 * never reach the OWNER's terminal.
 *
 * `psu-launcher.mjs` imports `psu-pty-host.mjs` IN-PROCESS, and `bridgeTty` defaults to
 * `stdin.isTTY`, so a bare `process.stderr.write` from a gated-delivery defer interleaves
 * straight into the agent TUI the owner is reading. That is how
 * `psu-pty-host: turn DEFERRED/REFUSED … (agent mid-turn > 180000ms cap)` became a
 * user-visible "error" — reported by the owner on 2026-09-22 against session
 * 25a7969c-c4ae-42ed-ac2f-357845447a84.
 *
 * The defer it announces was CORRECT: the native Claude transcript for that session shows an
 * unbroken tool_use/tool_result chain across the whole 05:15:38–05:18:38 wait window, and the
 * ledger recorded `observedMaxQuietMs` 276ms against a 1500ms threshold. So the fix is not to
 * stop deferring — it is to stop SHOUTING a correct, already-durably-recorded outcome into a
 * human's chat window.
 *
 * Scope discipline this test pins: suppression applies to the ROUTINE defer diagnostics only.
 * Host lifecycle and genuinely-unexpected failures must keep writing unconditionally, or we
 * would trade a cosmetic problem for an undiagnosable one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { shouldWriteHostDiagnostic } from '../scripts/psu-pty-host.mjs';

const HOST_SRC_PATH = fileURLToPath(new URL('../scripts/psu-pty-host.mjs', import.meta.url));
const HOST_SRC = readFileSync(HOST_SRC_PATH, 'utf8');

describe('shouldWriteHostDiagnostic', () => {
  it('SUPPRESSES on a bridged TTY — this is the owner-visible case', () => {
    expect(shouldWriteHostDiagnostic({ bridgeTty: true, env: {} })).toBe(false);
  });

  it('WRITES when there is no bridged terminal (headless member, nobody is reading)', () => {
    expect(shouldWriteHostDiagnostic({ bridgeTty: false, env: {} })).toBe(true);
  });

  it('PAPERCUSP_PTY_HOST_DIAG=1 forces the line back on for interactive debugging', () => {
    expect(
      shouldWriteHostDiagnostic({ bridgeTty: true, env: { PAPERCUSP_PTY_HOST_DIAG: '1' } }),
    ).toBe(true);
  });

  it('only the exact opt-in value re-enables it — a stray truthy string does not', () => {
    for (const value of ['0', '', 'true', 'yes', 'on']) {
      expect(
        shouldWriteHostDiagnostic({ bridgeTty: true, env: { PAPERCUSP_PTY_HOST_DIAG: value } }),
      ).toBe(false);
    }
  });

  it('defaults are safe when called with no arguments at all', () => {
    expect(() => shouldWriteHostDiagnostic()).not.toThrow();
  });
});

describe('the three routine defer diagnostics are routed, not bare', () => {
  /**
   * Source-text guard. The subject is `psu-pty-host.mjs`, a DIFFERENT file from this one, so
   * the self-match trap that bites a guard whose fixture lives inside its own subject does not
   * apply here — but the guard is still written against the CALL, not against prose, so a
   * comment mentioning `process.stderr.write` (the helper's own docstring does) can never
   * satisfy or break it.
   */
  const ROUTINE_DEFER_MARKERS = [
    'DEFERRED for ${ownerId} (${reason})',
    'DEFERRED/REFUSED for ${ownerId}',
    'DEFERRED for ${ownerId} (quota-blocked;',
  ];

  it.each(ROUTINE_DEFER_MARKERS)('%s is emitted via writeHostDiagnostic', (marker) => {
    const at = HOST_SRC.indexOf(marker);
    // Positive control: if the marker itself has been reworded, this guard is measuring
    // NOTHING and must fail loudly rather than pass vacuously.
    expect(at, `defer marker not found in psu-pty-host.mjs — reword the guard: ${marker}`).
      toBeGreaterThan(-1);

    // The emitting call is the nearest preceding statement. Look back a bounded window and
    // require the router, not a bare stderr write.
    const window = HOST_SRC.slice(Math.max(0, at - 400), at);
    expect(window).toContain('writeHostDiagnostic(');
    expect(window).not.toContain('process.stderr.write(');
  });

  it('the router itself is the ONLY place these lines can reach stderr', () => {
    expect(HOST_SRC).toContain('const writeHostDiagnostic = (text) => {');
    expect(HOST_SRC).toContain('if (!shouldWriteHostDiagnostic({ bridgeTty, env })) return false;');
  });

  it('host lifecycle/unexpected-failure writes are NOT suppressed', () => {
    // The gated-delivery pipeline's unexpected-throw path must still write unconditionally:
    // silencing it would make a real host fault invisible.
    expect(HOST_SRC).toContain('gated delivery pipeline threw for');
    const at = HOST_SRC.indexOf('gated delivery pipeline threw for');
    const window = HOST_SRC.slice(Math.max(0, at - 300), at);
    expect(window).toContain('process.stderr.write(');
  });
});
