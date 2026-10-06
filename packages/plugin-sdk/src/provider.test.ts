import { describe, expect, it } from 'vitest';
import { validateProviderDescriptor, type ProviderDescriptor } from './provider';

/**
 * Value rules for a provider's OAuth identity endpoint (linear-asana-task-sync-2026-10-05 P-004).
 * Linear answers only GraphQL, so its identity request is a POST with a JSON body; a REST
 * provider (GitHub) keeps the default GET with no body.
 */
function descriptor(identity: Record<string, unknown>): ProviderDescriptor {
  return {
    id: 'example-tracker',
    contractVersion: 1,
    displayName: 'Example tracker',
    datatypes: ['ticket'],
    capabilities: ['ticket.read'],
    egressHosts: ['api.example.com', 'example.com'],
    oauth: {
      authorizeUrl: 'https://example.com/oauth/authorize?actor=app',
      tokenUrl: 'https://api.example.com/oauth/token',
      scopes: ['read'],
      identity: identity as unknown as NonNullable<ProviderDescriptor['oauth']>['identity'],
    },
  };
}

const GRAPHQL_BODY = JSON.stringify({ query: '{ organization { id name } }' });

/** A new source's starting destination policy (WI-10006213): keyed by declared datatypes only. */
describe('validateProviderDescriptor: defaultDestinations', () => {
  const base = { ...descriptor({ url: 'https://api.example.com/user', idField: 'id' }), datatypes: ['ticket', 'ticket-comment'] };

  it('accepts declared datatypes routed to record, event or document', () => {
    expect(validateProviderDescriptor({ ...base, defaultDestinations: { ticket: ['record'], 'ticket-comment': ['document'] } })).toEqual([]);
  });

  it('refuses a datatype the provider does not declare', () => {
    expect(validateProviderDescriptor({ ...base, defaultDestinations: { 'email-message': ['document'] } }))
      .toContain('provider.defaultDestinations key "email-message" is not one of provider.datatypes');
  });

  it('refuses an unknown destination, an empty list, a repeat and a non-map', () => {
    const issues = (defaults: unknown) =>
      validateProviderDescriptor({ ...base, defaultDestinations: defaults as ProviderDescriptor['defaultDestinations'] });
    expect(issues({ ticket: ['inbox'] })).toContain('provider.defaultDestinations.ticket entry "inbox" must be one of record, event, document');
    expect(issues({ ticket: [] })).toContain('provider.defaultDestinations.ticket must list at least one destination');
    expect(issues({ ticket: ['record', 'record'] })).toContain('provider.defaultDestinations.ticket repeats "record"');
    expect(issues(['ticket'])).toContain('provider.defaultDestinations must map datatypes to destination lists');
  });
});

describe('validateProviderDescriptor: oauth.scopeSeparator', () => {
  it('accepts a space or a comma and refuses anything else', () => {
    const base = descriptor({ url: 'https://api.example.com/user', idField: 'id' });
    expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, scopeSeparator: ',' } })).toEqual([]);
    expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, scopeSeparator: ' ' } })).toEqual([]);
    expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, scopeSeparator: ';' as unknown as ',' } }))
      .toContain('provider.oauth.scopeSeparator must be " " or ","');
  });
});

describe('validateProviderDescriptor: oauth.identity request', () => {
  it('accepts a GET identity endpoint with no method (the REST default)', () => {
    expect(validateProviderDescriptor(descriptor({ url: 'https://api.example.com/user', idField: 'id' }))).toEqual([]);
  });

  it('accepts a POST identity endpoint with a JSON body (a GraphQL API)', () => {
    expect(validateProviderDescriptor(descriptor({
      url: 'https://api.example.com/graphql', idField: 'data.organization.id', method: 'POST', body: GRAPHQL_BODY,
    }))).toEqual([]);
  });

  it('refuses an unknown method', () => {
    expect(validateProviderDescriptor(descriptor({ url: 'https://api.example.com/user', idField: 'id', method: 'PUT' })))
      .toContain('provider.oauth.identity.method must be GET or POST');
  });

  it('refuses a body without POST, and a body that is not JSON', () => {
    expect(validateProviderDescriptor(descriptor({ url: 'https://api.example.com/user', idField: 'id', body: GRAPHQL_BODY })))
      .toContain('provider.oauth.identity.body needs method POST');
    expect(validateProviderDescriptor(descriptor({
      url: 'https://api.example.com/graphql', idField: 'id', method: 'POST', body: '{ organization { id } }',
    }))).toContain('provider.oauth.identity.body must be a JSON string');
  });

  it('keeps the identity host inside the egress allow-list', () => {
    expect(validateProviderDescriptor(descriptor({
      url: 'https://elsewhere.test/graphql', idField: 'id', method: 'POST', body: GRAPHQL_BODY,
    }))).toContain('provider.oauth endpoint host "elsewhere.test" is not in provider.egressHosts');
  });
});

/** Push-wake scheme (linear-asana-task-sync-2026-10-05 D-016): pure data the host verifies. */
describe('validateProviderDescriptor: push', () => {
  const base = descriptor({ url: 'https://api.example.com/user', idField: 'id' });
  const signature = { header: 'x-hook-signature', algorithm: 'hmac-sha256', encoding: 'hex' } as const;
  const withPush = (push: unknown, capabilities = ['ticket.read', 'push.subscribe', 'push.unsubscribe']) =>
    validateProviderDescriptor({ ...base, capabilities, push } as ProviderDescriptor);

  it('accepts a handshake scheme with both push capabilities, and a signature-only scheme without them', () => {
    expect(withPush({ handshake: { header: 'x-hook-secret' }, signature })).toEqual([]);
    expect(withPush({ signature }, ['ticket.read'])).toEqual([]);
  });

  it('a handshake needs push.subscribe and push.unsubscribe, since its secret only arrives during a subscribe', () => {
    expect(withPush({ handshake: { header: 'x-hook-secret' }, signature }, ['ticket.read', 'push.subscribe']))
      .toEqual(['provider.push.handshake needs capability push.unsubscribe']);
    expect(withPush({ handshake: { header: 'x-hook-secret' }, signature }, ['ticket.read'])).toHaveLength(2);
  });

  it('refuses a missing or malformed signature, a non-lowercase header, and a handshake sharing the signature header', () => {
    expect(withPush({})).toEqual([
      'provider.push.signature.header must be a lowercase header name',
      'provider.push.signature.algorithm must be hmac-sha256',
      'provider.push.signature.encoding must be hex',
    ]);
    expect(withPush({ signature: { ...signature, header: 'X-Hook-Signature' } }))
      .toContain('provider.push.signature.header must be a lowercase header name');
    expect(withPush({ signature: { ...signature, algorithm: 'sha1' } })).toContain('provider.push.signature.algorithm must be hmac-sha256');
    expect(withPush({ handshake: { header: 'x-hook-signature' }, signature }))
      .toContain('provider.push.handshake.header must differ from provider.push.signature.header');
    expect(withPush('push')).toEqual(['provider.push must be an object']);
  });
});
