import { describe, expect, it } from 'vitest';
import { computeDiagnosticVintage, shaMatches } from './diagnostic-vintage';

describe('diagnostic vintage', () => {
  it('matches full and short commit identities by prefix', () => {
    expect(shaMatches('abcdef0123456789', 'abcdef0')).toBe(true);
    expect(shaMatches('abcdef0123456789', '1234567')).toBe(false);
    expect(shaMatches(null, 'abcdef0')).toBeNull();
  });

  it('marks a process stale when it does not match staging and warns before action', () => {
    const result = computeDiagnosticVintage({
      processSha: '1111111aaaaaaa',
      stagingHeadSha: '2222222bbbbbbb',
      greenPinSha: '3333333ccccccc',
    });
    expect(result).toMatchObject({
      status: 'stale',
      processMatchesStaging: false,
      processMatchesGreenPin: false,
    });
    expect(result.warning).toContain('may predate current fixes');
  });

  it('does not claim freshness when an identity is unavailable', () => {
    const result = computeDiagnosticVintage({ processSha: null, stagingHeadSha: '2222222bbbbbbb', greenPinSha: null });
    expect(result.status).toBe('unknown');
    expect(result.warning).toContain('UNKNOWN');
  });
});
