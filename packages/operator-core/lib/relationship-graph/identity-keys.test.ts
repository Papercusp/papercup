/**
 * Identity keys of the platform relationship graph (crm-agent-sales-onboarding-apps-2026-10-06
 * P-002): normalization is conservative, so two records only merge on an unambiguous match.
 */
import { describe, expect, it } from 'vitest';
import {
  interactionParticipantKeys,
  isFreeMailDomain,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  organizationIdentityKeys,
  personIdentityKeys,
  personOrganizationDomain,
} from './identity-keys';

describe('normalizeEmail', () => {
  it('lowercases, trims and unwraps a display-name address', () => {
    expect(normalizeEmail('  Ada Lovelace <Ada@Acme.COM> ')).toBe('ada@acme.com');
    expect(normalizeEmail('mailto:BOB@acme.com')).toBe('bob@acme.com');
  });
  it('keeps plus-tags and dots (a different mailbox is not assumed equal)', () => {
    expect(normalizeEmail('ada+crm@acme.com')).toBe('ada+crm@acme.com');
    expect(normalizeEmail('a.da@gmail.com')).toBe('a.da@gmail.com');
  });
  it('refuses non-addresses', () => {
    for (const bad of ['', 'ada', 'ada@', '@acme.com', 'ada@acme', 'a b@acme.com', 42, null]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe('normalizePhone', () => {
  it('keeps the + country prefix and strips formatting', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('tel:+44 20 7946 0000')).toBe('+442079460000');
  });
  it('reads a 00 international prefix as +', () => {
    expect(normalizePhone('00 44 20 7946 0000')).toBe('+442079460000');
  });
  it('does not invent a country code for a national number', () => {
    expect(normalizePhone('555-123-4567')).toBe('5551234567');
    expect(normalizePhone('555-123-4567')).not.toBe(normalizePhone('+1 555 123 4567'));
  });
  it('drops an extension and refuses out-of-range lengths', () => {
    expect(normalizePhone('+1 555 123 4567 ext. 89')).toBe('+15551234567');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+1234567890123456')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});

describe('normalizeDomain', () => {
  it('extracts the host of a URL, email or bare domain without www', () => {
    expect(normalizeDomain('https://www.Acme.com/about?x=1')).toBe('acme.com');
    expect(normalizeDomain('ada@acme.co.uk')).toBe('acme.co.uk');
    expect(normalizeDomain('acme.io:8080')).toBe('acme.io');
  });
  it('refuses non-domains', () => {
    for (const bad of ['', 'localhost', 'not a domain', '-acme.com', null]) expect(normalizeDomain(bad)).toBeNull();
  });
});

describe('identity keys', () => {
  it('person keys come from emails and phones in any provider shape, sorted and unique', () => {
    const keys = personIdentityKeys({
      emails: ['Ada@Acme.com', { value: 'ada@personal.example' }, 'ada@acme.com'],
      email: 'ada@acme.com',
      phones: [{ number: '+1 555 123 4567' }],
      phone: 'not a phone',
    });
    expect(keys).toEqual(['email:ada@acme.com', 'email:ada@personal.example', 'phone:+15551234567']);
  });
  it('organization keys come from domains, domain and website', () => {
    expect(organizationIdentityKeys({ domains: ['Acme.com'], website: 'https://www.acme.com', domain: 'acme.io' }))
      .toEqual(['domain:acme.com', 'domain:acme.io']);
  });
  it('a person with no email or phone has no keys (it never merges)', () => {
    expect(personIdentityKeys({ displayName: 'Ada' })).toEqual([]);
  });
});

describe('personOrganizationDomain', () => {
  it('uses the first work email domain and skips free-mail', () => {
    expect(personOrganizationDomain({ emails: ['ada@gmail.com', 'ada@acme.com'] })).toBe('acme.com');
    expect(personOrganizationDomain({ emails: ['ada@gmail.com'] })).toBeNull();
    expect(isFreeMailDomain('Outlook.com')).toBe(true);
  });
  it('prefers an explicit organizationDomain', () => {
    expect(personOrganizationDomain({ organizationDomain: 'https://acme.org', emails: ['ada@acme.com'] })).toBe('acme.org');
  });
});

describe('interactionParticipantKeys', () => {
  it('email-message participants are from/to/cc/bcc', () => {
    expect(interactionParticipantKeys('email-message', {
      from: 'Ada <ada@acme.com>', to: ['bob@beta.io'], cc: 'carol@gamma.net', bcc: [],
    })).toEqual(['email:ada@acme.com', 'email:bob@beta.io', 'email:carol@gamma.net']);
  });
  it('calendar-event attendees may be strings or objects', () => {
    expect(interactionParticipantKeys('calendar-event', {
      organizer: 'ada@acme.com', attendees: [{ email: 'bob@beta.io', displayName: 'Bob' }, 'carol@gamma.net'],
    })).toEqual(['email:ada@acme.com', 'email:bob@beta.io', 'email:carol@gamma.net']);
  });
  it('call participants are phones or emails', () => {
    expect(interactionParticipantKeys('call', { from: '+1 555 123 4567', to: ['ada@acme.com'] }))
      .toEqual(['email:ada@acme.com', 'phone:+15551234567']);
  });
  it('an unknown datatype has no participants', () => {
    expect(interactionParticipantKeys('social-post', { author: '@ada' })).toEqual([]);
  });
});
