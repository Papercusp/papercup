/**
 * EI-20233090880522791 — pins `capability:fetch`'s credential-gate prose to the code
 * that owns each fact: the token path (SUPERUSER_TOKEN_PATH) and the measured HTTP
 * status (200, not the intuitive 401/403).
 *
 * The wrong-status controls are the point of this file. 401/403 is what a reader
 * expects, so a future editor "correcting" the 200 would believe they were fixing a
 * typo. These controls make that correction fail loudly instead.
 */
import { describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import { SUPERUSER_TOKEN_PATH } from '../superuser-token';
import { judgeFetchSuperuserGateClaim } from './fetch-superuser-gate-claim';
import '../agent-tools/capability/fetch';

const HOME = '/home/agent';
const GOOD_PATH = `${HOME}/.papercusp/superuser-token`;

/** The shape the live tool carries, reduced to what this claim judges. */
function surfacesOf(): { description: string; when?: string } {
  const tool = lookupByMcpName('capability:fetch');
  expect(tool, 'capability:fetch not registered').toBeDefined();
  return { description: tool!.description ?? '', when: tool!.guidance?.when };
}

describe('capability:fetch superuser-gate doc-claim', () => {
  it('the LIVE tool prose satisfies the claim (calibration — without this the controls prove nothing)', () => {
    const verdict = judgeFetchSuperuserGateClaim(surfacesOf(), { tokenPath: SUPERUSER_TOKEN_PATH });
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('the live prose actually NAMES the token path, so the drift pin has a subject', () => {
    // Guards against the pin going vacuous: a rule about paths that names no path
    // passes trivially forever.
    const verdict = judgeFetchSuperuserGateClaim(surfacesOf(), { tokenPath: SUPERUSER_TOKEN_PATH });
    expect(verdict.tokenPathsNamed.length).toBeGreaterThan(0);
  });

  it('the named path resolves to the path superuser-token.ts actually reads', () => {
    const tool = lookupByMcpName('capability:fetch');
    const prose = `${tool!.description ?? ''}\n${tool!.guidance?.when ?? ''}`;
    // Expressed independently of the judge, so a bug in the judge cannot hide drift.
    expect(prose).toContain('$PAPERCUSP_HOME/superuser-token');
    expect(SUPERUSER_TOKEN_PATH.endsWith('/superuser-token')).toBe(true);
  });

  // ---- CONTROLS: each must be CAUGHT, or the claim above is vacuous ----

  it('CONTROL catches a drifted token path', () => {
    const verdict = judgeFetchSuperuserGateClaim(
      { description: 'Send Authorization: Bearer from ~/.config/superuser-token for ?superuser=1.' },
      { tokenPath: GOOD_PATH, homeDir: HOME },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toContain('SUPERUSER_TOKEN_PATH');
  });

  it('CONTROL catches a credential clause asserting 401', () => {
    const verdict = judgeFetchSuperuserGateClaim(
      { description: 'Without the bearer the ?superuser=1 endpoint returns 401 Unauthorized.' },
      { tokenPath: GOOD_PATH, homeDir: HOME },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.wrongStatusClaims).toHaveLength(1);
  });

  it('CONTROL catches a credential clause asserting 403', () => {
    const verdict = judgeFetchSuperuserGateClaim(
      { description: 'A missing superuser-token yields 403.' },
      { tokenPath: GOOD_PATH, homeDir: HOME },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.wrongStatusClaims).toHaveLength(1);
  });

  it('CONTROL catches the wrong status in guidance.when, not just the description', () => {
    // Correcting one delivered surface and not the other is a previously-observed
    // failure (EI-20218215840085630), so both are judged.
    const verdict = judgeFetchSuperuserGateClaim(
      {
        description: 'Ordinary prose with no credential claim.',
        when: 'A ?superuser=1 call without a bearer returns 403.',
      },
      { tokenPath: GOOD_PATH, homeDir: HOME },
    );
    expect(verdict.ok).toBe(false);
  });

  // ---- CONTROLS: each must be ALLOWED, or the claim is over-strict ----

  it('does NOT flag the 406 Accept clause, which legitimately names a status', () => {
    const verdict = judgeFetchSuperuserGateClaim(
      {
        description:
          'Send Accept: application/json, text/event-stream; application/json alone returns 406. ' +
          `A ?superuser=1 endpoint needs Authorization: Bearer from ${GOOD_PATH}.`,
      },
      { tokenPath: GOOD_PATH, homeDir: HOME },
    );
    expect(verdict.violations).toEqual([]);
  });

  it('allows prose that says nothing about the credential gate (silence is not the failure mode)', () => {
    const verdict = judgeFetchSuperuserGateClaim(
      { description: 'Make an outbound HTTP request and return status, headers and body.' },
      { tokenPath: GOOD_PATH, homeDir: HOME },
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.tokenPathsNamed).toEqual([]);
  });

  it('accepts a correctly-named path written with $HOME as well as ~', () => {
    const verdict = judgeFetchSuperuserGateClaim(
      { description: 'Bearer from $HOME/.papercusp/superuser-token for ?superuser=1.' },
      { tokenPath: GOOD_PATH, homeDir: HOME },
    );
    expect(verdict.ok).toBe(true);
  });

  it('resolves $PAPERCUSP_HOME against the scoped token home', () => {
    const verdict = judgeFetchSuperuserGateClaim(
      { description: 'Bearer from $PAPERCUSP_HOME/superuser-token for ?superuser=1.' },
      { tokenPath: `${HOME}/scoped/superuser-token`, homeDir: HOME, papercuspHome: `${HOME}/scoped` },
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.tokenPathsNamed).toEqual(['$PAPERCUSP_HOME/superuser-token']);
  });

  it('catches a scoped-home path whose expansion does not match the token reader', () => {
    const verdict = judgeFetchSuperuserGateClaim(
      { description: 'Bearer from $PAPERCUSP_HOME/superuser-token for ?superuser=1.' },
      { tokenPath: GOOD_PATH, homeDir: HOME, papercuspHome: `${HOME}/other` },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toContain('SUPERUSER_TOKEN_PATH');
  });
});
