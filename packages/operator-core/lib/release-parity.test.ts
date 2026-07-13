import { describe, expect, it } from 'vitest';
import { classifyReleaseParity } from './release-parity';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);

describe('classifyReleaseParity', () => {
  it('matches only exact tested, claimed, actual, and green identities', () => {
    expect(
      classifyReleaseParity({ testedSha: a, claimedDeployedSha: a, actualDeployedSha: a, greenPinSha: a }),
    ).toMatchObject({
      ok: true,
      state: 'matched',
      nextVerb: null,
    });
  });
  it('fails closed when any authority is missing', () => {
    expect(
      classifyReleaseParity({ testedSha: a, claimedDeployedSha: a, actualDeployedSha: null, greenPinSha: a }),
    ).toMatchObject({ ok: false, state: 'unresolved' });
  });
  it('rejects a caller claim stale relative to the actual live deploy', () => {
    expect(
      classifyReleaseParity({ testedSha: a, claimedDeployedSha: a, actualDeployedSha: b, greenPinSha: b }),
    ).toMatchObject({ ok: false, state: 'claimed-deploy-stale' });
  });
  it('rejects tests run against a different live deployment', () => {
    expect(
      classifyReleaseParity({ testedSha: a, claimedDeployedSha: b, actualDeployedSha: b, greenPinSha: b }),
    ).toMatchObject({ ok: false, state: 'tested-deploy-mismatch' });
  });
  it('rejects a force-deployed SHA that is not the green pin', () => {
    expect(
      classifyReleaseParity({ testedSha: a, claimedDeployedSha: a, actualDeployedSha: a, greenPinSha: b }),
    ).toMatchObject({ ok: false, state: 'deployed-not-green' });
  });
  it('does not treat a short prefix as exact parity', () => {
    expect(
      classifyReleaseParity({ testedSha: a.slice(0, 9), claimedDeployedSha: a, actualDeployedSha: a, greenPinSha: a }),
    ).toMatchObject({ ok: false, state: 'unresolved' });
  });
});
