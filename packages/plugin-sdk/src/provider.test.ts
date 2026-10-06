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
