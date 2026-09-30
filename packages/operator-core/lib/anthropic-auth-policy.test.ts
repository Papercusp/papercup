import { describe, expect, it } from 'vitest';
import {
  isPublicDistribution,
  OWN_SUBSCRIPTION_RELAY_OPT_IN_ENV,
  subscriptionRelayAllowed,
  type SubscriptionRelay,
} from './anthropic-auth-policy';

const RELAYS: SubscriptionRelay[] = ['account-pool', 'credential-sync', 'honor-account', 'gateway-reinjection'];

describe('anthropic-auth-policy (open-source-release D-005)', () => {
  it('leaves every relay on outside a public build', () => {
    for (const profile of [undefined, 'dogfood', 'vm-release', 'hosted-control-plane']) {
      const env = { PAPERCUSP_DISTRIBUTION_PROFILE: profile } as NodeJS.ProcessEnv;
      expect(isPublicDistribution(env)).toBe(false);
      for (const r of RELAYS) expect(subscriptionRelayAllowed(r, env)).toBe(true);
    }
  });

  it('withholds every subscription relay in a public build', () => {
    const env = { PAPERCUSP_DISTRIBUTION_PROFILE: 'public' } as NodeJS.ProcessEnv;
    expect(isPublicDistribution(env)).toBe(true);
    for (const r of RELAYS) expect(subscriptionRelayAllowed(r, env)).toBe(false);
  });

  it('only the exact opt-in value re-enables them for the user\'s own accounts', () => {
    for (const [value, allowed] of [['1', true], ['true', false], ['0', false], ['', false]] as const) {
      const env = { PAPERCUSP_DISTRIBUTION_PROFILE: 'public', [OWN_SUBSCRIPTION_RELAY_OPT_IN_ENV]: value } as NodeJS.ProcessEnv;
      for (const r of RELAYS) expect(subscriptionRelayAllowed(r, env)).toBe(allowed);
    }
  });
});
