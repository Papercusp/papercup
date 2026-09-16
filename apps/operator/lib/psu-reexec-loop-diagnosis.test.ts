// @vitest-environment node
/**
 * WI-10001537: `missingReexecLoopDiagnosis` / `warnMissingReexecLoop`.
 *
 * `reexecExitCodeFrom` returning null is usually CORRECT — a headless member, a
 * nested psu, and the explicit kill switch all legitimately have no re-exec
 * loop, and psu-launcher must not take the adopting path for any of them. But
 * one cause is a silent fault: an unmanaged shim earlier on PATH that never
 * advertised the loop at all. That is what turned a hand-off into a hard exit
 * and destroyed a live `AskUserQuestion` dialog under the owner, with no signal
 * emitted anywhere.
 *
 * So the value being guarded here is not "does it warn" but "does it warn ONLY
 * for the actionable cause". A warning that also fired on the three benign
 * nulls would print on every headless spawn and every nested launch — noise
 * that trains everyone to ignore it, which is strictly worse than silence. Both
 * directions are asserted deliberately.
 */
import { describe, it, expect } from 'vitest';
import { missingReexecLoopDiagnosis, warnMissingReexecLoop } from '../scripts/psu-pty-host.mjs';

const PPID = 4242;
/** The env a correctly-managed shim exports. */
const wired = { PAPERCUSP_PSU_REEXEC: '87', PAPERCUSP_PSU_REEXEC_PPID: String(PPID) };

describe('missingReexecLoopDiagnosis', () => {
  it('returns null when the loop IS wired — there is nothing to explain', () => {
    expect(missingReexecLoopDiagnosis(wired, PPID)).toBeNull();
  });

  it('flags the INCIDENT case as actionable: nobody advertised a loop', () => {
    // This is exactly the stale ~/.local/bin/psu wrapper: it execs the launcher
    // and exports nothing.
    const d = missingReexecLoopDiagnosis({}, PPID);
    expect(d).toMatchObject({ reason: 'unadvertised', actionable: true });
    expect(d?.detail).toContain('PAPERCUSP_PSU_REEXEC');
  });

  it('flags a malformed advertisement as actionable rather than reading it as a promise', () => {
    // Number(), not parseInt() — '87abc' must not be honoured as 87 upstream, and
    // must not be silently ignored here either.
    const d = missingReexecLoopDiagnosis({ ...wired, PAPERCUSP_PSU_REEXEC: '87abc' }, PPID);
    expect(d).toMatchObject({ reason: 'malformed', actionable: true });
  });

  it('stays silent for the explicit kill switch', () => {
    const d = missingReexecLoopDiagnosis({ ...wired, PAPERCUSP_PSU_HOST_ADOPT: '0' }, PPID);
    expect(d).toMatchObject({ reason: 'kill-switch', actionable: false });
  });

  it('stays silent for a NESTED launch, which is common and expected', () => {
    // Env vars are inherited by every descendant, so a psu run from inside a psu
    // terminal reads its PARENT's advertisement. Rejecting it is correct; warning
    // about it every time would be the false alarm that kills the signal.
    const d = missingReexecLoopDiagnosis({ ...wired, PAPERCUSP_PSU_REEXEC_PPID: '999' }, PPID);
    expect(d).toMatchObject({ reason: 'nested', actionable: false });
  });
});

describe('warnMissingReexecLoop', () => {
  function capture(opts: Record<string, unknown>) {
    const lines: string[] = [];
    const emitted = warnMissingReexecLoop({ write: (s: string) => lines.push(s), ...opts });
    return { emitted, lines };
  }

  it('warns on an interactive launch with an actionable diagnosis', () => {
    const { emitted, lines } = capture({
      diagnosis: missingReexecLoopDiagnosis({}, PPID),
      interactive: true,
    });
    expect(emitted).toBeTruthy();
    expect(lines).toHaveLength(1);
    // The message has to name the ACTION, not just the condition — the whole
    // failure was that nobody knew to look at PATH.
    expect(lines[0]).toContain('command -v psu');
    expect(lines[0]).toContain('WI-10001537');
  });

  it('says NOTHING when there is no human attached', () => {
    // A headless member losing its process is relaunched by its supervisor; there
    // is no dialog to destroy and no one to read the warning.
    const { emitted, lines } = capture({
      diagnosis: missingReexecLoopDiagnosis({}, PPID),
      interactive: false,
    });
    expect(emitted).toBeNull();
    expect(lines).toEqual([]);
  });

  it('says NOTHING for a benign null, even interactively', () => {
    for (const env of [
      { ...wired, PAPERCUSP_PSU_HOST_ADOPT: '0' },
      { ...wired, PAPERCUSP_PSU_REEXEC_PPID: '999' },
    ]) {
      const { emitted, lines } = capture({
        diagnosis: missingReexecLoopDiagnosis(env, PPID),
        interactive: true,
      });
      expect(emitted).toBeNull();
      expect(lines).toEqual([]);
    }
  });

  it('says NOTHING when the loop is wired', () => {
    const { emitted } = capture({
      diagnosis: missingReexecLoopDiagnosis(wired, PPID),
      interactive: true,
    });
    expect(emitted).toBeNull();
  });

  it('survives a closed stderr rather than taking the launch down', () => {
    expect(() =>
      warnMissingReexecLoop({
        diagnosis: missingReexecLoopDiagnosis({}, PPID),
        interactive: true,
        write: () => {
          throw new Error('EPIPE');
        },
      }),
    ).not.toThrow();
  });
});
