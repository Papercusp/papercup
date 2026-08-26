import { describe, expect, it } from 'vitest';
import { mailPersonalAccessRefusal } from './reply';

describe('mail:reply personal authorization refusal', () => {
  it('does not present owner-directed AUTO as a Gmail grant or a draft bypass', () => {
    expect(mailPersonalAccessRefusal('no_live_grant')).toEqual({
      allowed: false,
      refusal: 'no_live_grant',
      requiredScope: 'personal:gmail',
      autoAuthoritySufficient: false,
      draftAvailable: false,
      guidance:
        'Owner-directed AUTO authorizes execution posture but is not a personal-vault grant. ' +
        'Establish a live principal-bound personal:gmail grant first; both draft and send modes require it.',
    });
  });
});
