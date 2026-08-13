/**
 * EI-20369673282334981 — the attribution half of the residue probe.
 *
 * The census can now report a dead-window scope that holds a listener nobody
 * claims, and `PAPERCUSP_SID` is what makes such a scope ATTRIBUTABLE to the agent
 * session whose shell launched it (env is inherited, at any depth). Measured on
 * this box 2026-08-13: 52 of 200 readable `/proc/<pid>/environ` carried it.
 *
 * The failure this guards is a WRONG attribution, which is worse than none: a
 * session id pinned to the wrong process invites someone to reason about who owns
 * a running server from a string that was never about that process.
 */
import { describe, expect, it } from 'vitest';

import { owningSessionId, parseOwningSessionId } from './residue-liveness-probe';

/** `/proc/<pid>/environ` is NUL-separated, with a trailing NUL. */
const environ = (...pairs: string[]) => pairs.map((p) => `${p}\0`).join('');

describe('parseOwningSessionId', () => {
  it('reads PAPERCUSP_SID out of a NUL-separated environ blob', () => {
    expect(
      parseOwningSessionId(environ('PATH=/usr/bin', 'PAPERCUSP_SID=su-5adeb7ac', 'HOME=/root')),
    ).toBe('su-5adeb7ac');
  });

  it('returns null when the variable is absent — the MAJORITY case, not an error', () => {
    // 148 of the 200 pids sampled carried no session env at all: systemd units,
    // pre-operator bootstraps, anything the owner started by hand. Null here must
    // mean "no opinion", never "unowned".
    expect(parseOwningSessionId(environ('PATH=/usr/bin', 'HOME=/root'))).toBeNull();
  });

  it('returns null for an empty environ', () => {
    expect(parseOwningSessionId('')).toBeNull();
  });

  it('treats an exported-but-BLANK value as unset, not as a session named ""', () => {
    // An empty string would attribute the process to a session that cannot exist,
    // and would compare unequal to every real id while looking populated.
    expect(parseOwningSessionId(environ('PAPERCUSP_SID='))).toBeNull();
    expect(parseOwningSessionId(environ('PAPERCUSP_SID=   '))).toBeNull();
  });

  it('does NOT match a variable whose name merely ENDS with PAPERCUSP_SID', () => {
    // The wrong-attribution failure: `MY_PAPERCUSP_SID` is a different variable,
    // and a substring search would silently adopt its value as the owner.
    expect(parseOwningSessionId(environ('MY_PAPERCUSP_SID=su-wrong'))).toBeNull();
    expect(parseOwningSessionId(environ('OLD_PAPERCUSP_SID=su-wrong', 'PAPERCUSP_SID=su-right'))).toBe(
      'su-right',
    );
  });

  it('keeps a value containing "=" intact — split("=") would truncate it', () => {
    expect(parseOwningSessionId(environ('PAPERCUSP_SID=su-a=b=c'))).toBe('su-a=b=c');
  });

  it('takes the FIRST occurrence, so a duplicated export cannot flip attribution', () => {
    expect(parseOwningSessionId(environ('PAPERCUSP_SID=su-first', 'PAPERCUSP_SID=su-second'))).toBe(
      'su-first',
    );
  });
});

describe('owningSessionId', () => {
  it('fails SOFT to null on an unreadable pid rather than throwing', () => {
    // A pid that exited mid-scan, or one owned by another user, is the ordinary
    // case in a census pass — it must contribute nothing, not break the tick.
    expect(owningSessionId(0)).toBeNull();
    expect(owningSessionId(2_147_483_646)).toBeNull();
  });

  it('reads THIS process\'s own environ without throwing', () => {
    // Whether a session id is present depends on how the suite was launched, so
    // the assertion is on the contract (string | null), not on a value.
    const sid = owningSessionId(process.pid);
    expect(sid === null || typeof sid === 'string').toBe(true);
    if (sid !== null) expect(sid.length).toBeGreaterThan(0);
  });
});
