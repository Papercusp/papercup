import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CREDENTIAL_MAX_LENGTH,
  providerCredentialForHost,
  providerCredentialValueIssue,
  validateProviderDescriptor,
  type ProviderDescriptor,
} from './provider';

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

describe('validateProviderDescriptor: membership', () => {
  const base = descriptor({ url: 'https://api.example.com/user', idField: 'id' });

  it('accepts a membership feed that names its identity namespace', () => {
    expect(validateProviderDescriptor({ ...base, membership: { identityProvider: 'github' } })).toEqual([]);
  });

  it('refuses a missing, empty or malformed identity namespace', () => {
    const refusal = `provider.membership.identityProvider must match /^[a-z][a-z0-9-]{1,62}$/`;
    for (const membership of [{}, { identityProvider: '' }, { identityProvider: 'Git Hub' }, 'github', ['github']]) {
      expect(validateProviderDescriptor({ ...base, membership } as unknown as ProviderDescriptor)).toEqual([refusal]);
    }
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

/**
 * Paste-a-secret setup fields (cupboard-distributable-integrations-2026-10-10 P-001,
 * SPEC-R-2-P-001 / SPEC-R-7-P-001). A descriptor describes a secret's shape; it never carries one,
 * and every injected host has exactly one credential.
 */
describe('validateProviderDescriptor: setup.credentials', () => {
  const base: ProviderDescriptor = {
    id: 'example-chat',
    contractVersion: 1,
    datatypes: ['chat-message'],
    capabilities: ['chat.send'],
    egressHosts: ['api.example.com', '*.hooks.example.com'],
  };
  const withCredentials = (credentials: unknown, extra: Partial<ProviderDescriptor> = {}) =>
    validateProviderDescriptor({ ...base, ...extra, setup: { credentials } } as unknown as ProviderDescriptor);
  const bot = { key: 'bot_token', label: 'Bot token', pattern: 'xoxb-[A-Za-z0-9-]+', hosts: ['api.example.com'] };

  it('accepts injected and ingress-only fields with help text', () => {
    expect(
      withCredentials([
        { ...bot, help: 'OAuth & Permissions → Bot User OAuth Token', helpUrl: 'https://api.example.com/apps', placeholder: 'xoxb-…' },
        { key: 'app-token', label: 'App-level token', pattern: 'xapp-[A-Za-z0-9-]+' },
      ]),
    ).toEqual([]);
    // A host covered by an egress wildcard can carry a credential.
    expect(withCredentials([{ ...bot, hosts: ['in.hooks.example.com'] }])).toEqual([]);
  });

  it('refuses a field that carries a value', () => {
    for (const forbidden of ['value', 'default', 'secret', 'token']) {
      expect(withCredentials([{ ...bot, [forbidden]: 'xoxb-1' }])).toContain(
        `provider.setup.credentials[0].${forbidden} is not allowed: a descriptor never carries a credential value`,
      );
    }
  });

  it('refuses bad keys, repeats, missing labels and broken patterns', () => {
    expect(withCredentials([{ ...bot, key: 'Bot Token' }])).toContain(
      `provider.setup.credentials[0].key must match ${/^[a-z][a-z0-9_-]{0,62}$/}`,
    );
    expect(withCredentials([bot, { ...bot, hosts: undefined }])).toContain('provider.setup.credentials repeats key "bot_token"');
    expect(withCredentials([{ ...bot, label: '' }])).toContain('provider.setup.credentials[0].label must be a non-empty string');
    expect(withCredentials([{ ...bot, pattern: 'xoxb-[' }])).toContain('provider.setup.credentials[0].pattern is not a valid regular expression');
    expect(withCredentials([{ ...bot, helpUrl: 'http://example.com' }])).toContain('provider.setup.credentials[0].helpUrl must be an https URL');
    expect(withCredentials([])).toEqual(['provider.setup.credentials must list at least one field']);
    expect(validateProviderDescriptor({ ...base, setup: 'creds' } as unknown as ProviderDescriptor)).toEqual(['provider.setup must be an object']);
  });

  it('refuses a host outside egressHosts, a wildcard host, and a host two credentials claim', () => {
    expect(withCredentials([{ ...bot, hosts: ['api.other.com'] }])).toContain(
      "provider.setup.credentials[0] host 'api.other.com' is not in provider.egressHosts",
    );
    expect(withCredentials([{ ...bot, hosts: ['*.hooks.example.com'] }])).toContain(
      "provider.setup.credentials[0].hosts entry '*.hooks.example.com' is not a hostname",
    );
    expect(withCredentials([bot, { ...bot, key: 'user_token' }])).toContain(
      "provider.setup.credentials[1] host 'api.example.com' is already given a credential by provider.setup.credentials[0]",
    );
    expect(withCredentials([bot], { serviceCredentials: [{ ref: 'pubsub', hosts: ['api.example.com'] }] })).toContain(
      "provider.setup.credentials[0] host 'api.example.com' is already given a credential by provider.serviceCredentials",
    );
  });
});

describe('providerCredentialValueIssue', () => {
  const field = { label: 'Bot token', pattern: 'xoxb-[A-Za-z0-9-]+' };

  it('accepts a whole-value match, trimming surrounding space', () => {
    expect(providerCredentialValueIssue(field, 'xoxb-123-abc')).toBeNull();
    expect(providerCredentialValueIssue(field, '  xoxb-123-abc\n')).toBeNull();
    expect(providerCredentialValueIssue({ label: 'Key' }, 'anything-goes')).toBeNull();
  });

  it('refuses a value that only partly matches, is empty, contains spaces, or is too long', () => {
    expect(providerCredentialValueIssue(field, 'xapp-123')).toBe('Bot token does not have the expected format');
    expect(providerCredentialValueIssue(field, 'prefix xoxb-123')).toBe('Bot token must not contain spaces or line breaks');
    expect(providerCredentialValueIssue(field, 'xoxb-123!')).toBe('Bot token does not have the expected format');
    expect(providerCredentialValueIssue(field, '   ')).toBe('Bot token is required');
    expect(providerCredentialValueIssue(field, undefined)).toBe('Bot token is required');
    expect(providerCredentialValueIssue(field, `xoxb-${'a'.repeat(PROVIDER_CREDENTIAL_MAX_LENGTH)}`)).toBe(
      `Bot token is longer than ${PROVIDER_CREDENTIAL_MAX_LENGTH} characters`,
    );
  });

  it('reports an invalid provider pattern instead of throwing', () => {
    expect(providerCredentialValueIssue({ label: 'Key', pattern: '(' }, 'x')).toBe("Key cannot be checked: the provider's format is invalid");
  });
});

describe('providerCredentialForHost', () => {
  const d = { setup: { credentials: [{ key: 'bot_token', label: 'Bot', hosts: ['slack.com'] }, { key: 'app_token', label: 'App' }] } };
  it('finds the credential injected for a host, case-insensitively, and none for an ingress-only field', () => {
    expect(providerCredentialForHost(d, 'Slack.com')?.key).toBe('bot_token');
    expect(providerCredentialForHost(d, 'api.slack.com')).toBeNull();
    expect(providerCredentialForHost({}, 'slack.com')).toBeNull();
  });
});
