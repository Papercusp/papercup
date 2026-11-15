import { describe, expect, it } from 'vitest';
import { isolatedRuntimeEvidenceKeys, isolatedRuntimeInheritedEnvironment } from '../../../../../scripts/lib/with-test-pg-env.mjs';
import { parseRosterStopHttpControls, ROSTER_PROOF_KEYS, rosterStopHttpControlArgs } from '../../../test/roster-stop-http-controls';

describe('private roster fixture controls', () => {
  it.each(ROSTER_PROOF_KEYS)('recovers %s from explicit argv after the maintained scrub', key => {
    const source = { [key]: '1', ROSTER_STOP_HTTP_EVIDENCE_DIR: '/owned-proof',
      PAPERCUSP_OPERATOR_URL: 'https://live.invalid', PAPERCUSP_SID: 'live-owner' };
    const args = rosterStopHttpControlArgs(source);
    const { environment, discardedKeys } = isolatedRuntimeInheritedEnvironment(source,
      isolatedRuntimeEvidenceKeys('PAPERCUSP_TEST_OWNED_DB_DIR'));
    expect(discardedKeys).toEqual(expect.arrayContaining([key, 'PAPERCUSP_OPERATOR_URL', 'PAPERCUSP_SID']));
    expect(environment).toEqual({ ROSTER_STOP_HTTP_EVIDENCE_DIR: '/owned-proof' });
    expect(parseRosterStopHttpControls(args).proofs).toEqual({ [key]: '1' });
  });

  it('preserves the complete selector vector without an implicit first-proof choice', () => {
    const source = Object.fromEntries(ROSTER_PROOF_KEYS.map(key => [key, '1']));
    expect(parseRosterStopHttpControls(rosterStopHttpControlArgs(source)).proofs).toEqual(source);
    expect(parseRosterStopHttpControls([]).proofs).toEqual({});
  });

  it('selects the Health cleanup seed using its existing argv alone', () => {
    expect(parseRosterStopHttpControls(['--health-cleanup-proof'])).toEqual({ healthCleanupProof: true,
      healthPublicationProof: false, mutation: undefined,
      proofs: { ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_HEALTH_BROWSER_PROOF: '1' } });
  });

  it('selects the Health publication HTTP path using its existing argv alone', () => {
    expect(parseRosterStopHttpControls(['--health-publication-proof', '--prepared-api-sha=owned'])).toMatchObject({
      healthPublicationProof: true, proofs: { ROSTER_COORD_HTTP_PROOF: '1',
        ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_HEALTH_BROWSER_PROOF: '1' } });
  });

  it('preserves the explicit stop mutation instead of silently running the positive control', () => {
    const source = { ROSTER_STOP_HTTP_MUTATION: 'misroute' };
    expect(isolatedRuntimeInheritedEnvironment(source, isolatedRuntimeEvidenceKeys('owned')).environment).toEqual({});
    expect(parseRosterStopHttpControls(rosterStopHttpControlArgs(source)).mutation).toBe('misroute');
  });

  it.each([
    ['--roster-proof'], ['--roster-proof=unknown'], ['--browser-proof='],
    ['--roster-proof=ROSTER_COORD_HTTP_PROOF', '--roster-proof=ROSTER_COORD_HTTP_PROOF'],
    ['--health-cleanup-proof', '--health-cleanup-proof'],
    ['--health-cleanup-proof', '--health-publication-proof'], ['--health-publication-proof=1'],
    ['--stop-http-mutation=unknown'], ['--stop-http-mutation=misroute', '--stop-http-mutation=misroute'],
  ])('rejects malformed, duplicate, or ambiguous fixture controls %j', (...args) => {
    expect(() => parseRosterStopHttpControls(args)).toThrow(/roster/);
  });

  it('rejects unknown and invalid launcher controls without forwarding arbitrary ambient state', () => {
    expect(() => rosterStopHttpControlArgs({ ROSTER_UNKNOWN_PROOF: '1' })).toThrow(/unknown/);
    expect(() => rosterStopHttpControlArgs({ ROSTER_COORD_HTTP_PROOF: 'yes' })).toThrow(/must be 1 or 0/);
    expect(() => rosterStopHttpControlArgs({ ROSTER_STOP_HTTP_MUTATION: 'unknown' })).toThrow(/unsupported/);
    expect(rosterStopHttpControlArgs({ ROSTER_COORD_HTTP_PROOF: '0', PAPERCUSP_OPERATOR_URL: 'https://live.invalid' })).toEqual([]);
  });
});
