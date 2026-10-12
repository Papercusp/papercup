import { describe, expect, it } from 'vitest';
import {
  normalizeProviderOptions,
  PROVIDER_OPTIONS_MAX,
  providerOptionSourceOf,
  PROVIDER_APP_DEFINITION_MAX_LENGTH,
  PROVIDER_APP_DEFINITION_PLACEHOLDER,
  PROVIDER_CREDENTIAL_MAX_LENGTH,
  PROVIDER_INGRESS_NORMALIZE_CAPABILITY,
  providerAppDefinitionText,
  providerAppRegistrationUrl,
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

/**
 * The vendor app the owner creates before connecting (cupboard-distributable-integrations-2026-10-10
 * P-002, SPEC-R-2-P-002): a Create app link with the definition filled in, plus a copyable definition.
 */
describe('setup.appRegistration', () => {
  const base: ProviderDescriptor = {
    id: 'example-chat',
    contractVersion: 1,
    datatypes: ['chat-message'],
    capabilities: ['chat.send'],
    egressHosts: ['api.example.com'],
  };
  const manifest = { display_information: { name: 'Papercusp' }, settings: { socket_mode_enabled: true } };
  const slackLike = {
    createUrl: 'https://api.example.com/apps?new_app=1&manifest_json={definition}',
    definition: manifest,
    docsUrl: 'https://api.example.com/docs/app-manifests',
    copyHint: 'Choose Create New App, then From a manifest, and paste it.',
  };
  const withRegistration = (appRegistration: unknown) =>
    validateProviderDescriptor({ ...base, setup: { appRegistration } } as unknown as ProviderDescriptor);

  it('accepts a create link with the definition placeholder, docs and a copy hint, alone or beside credentials', () => {
    expect(withRegistration(slackLike)).toEqual([]);
    expect(withRegistration({ createUrl: 'https://api.example.com/apps/new' })).toEqual([]);
    expect(
      validateProviderDescriptor({
        ...base,
        setup: { appRegistration: slackLike, credentials: [{ key: 'bot_token', label: 'Bot token', hosts: ['api.example.com'] }] },
      }),
    ).toEqual([]);
  });

  it('opens the vendor page with the definition URL-encoded where the placeholder sits', () => {
    const url = providerAppRegistrationUrl(slackLike);
    expect(url.startsWith('https://api.example.com/apps?new_app=1&manifest_json=')).toBe(true);
    expect(url).not.toContain(PROVIDER_APP_DEFINITION_PLACEHOLDER);
    expect(JSON.parse(new URL(url).searchParams.get('manifest_json') ?? 'null')).toEqual(manifest);
    expect(providerAppRegistrationUrl({ createUrl: 'https://api.example.com/apps/new' })).toBe('https://api.example.com/apps/new');
  });

  it('copies the definition as pretty JSON, and offers nothing to copy when none is declared', () => {
    expect(providerAppDefinitionText(slackLike)).toBe(JSON.stringify(manifest, null, 2));
    expect(providerAppDefinitionText({})).toBeNull();
  });

  it('refuses a non-https link, an unknown placeholder, a placeholder with no definition, and a secret', () => {
    expect(withRegistration({ createUrl: 'http://api.example.com/apps' })).toContain('provider.setup.appRegistration.createUrl must be an https URL');
    expect(withRegistration({ createUrl: 'https://api.example.com/apps?team={team}', definition: manifest })).toContain(
      "provider.setup.appRegistration.createUrl placeholder '{team}' is unknown; only {definition} is filled in",
    );
    expect(withRegistration({ createUrl: slackLike.createUrl })).toContain(
      'provider.setup.appRegistration.createUrl uses {definition} but no definition is declared',
    );
    expect(withRegistration({ ...slackLike, clientSecret: 'x' })).toContain(
      'provider.setup.appRegistration.clientSecret is not allowed: a descriptor never carries a credential value',
    );
    expect(withRegistration({ ...slackLike, docsUrl: 'ftp://example.com' })).toContain('provider.setup.appRegistration.docsUrl must be an https URL');
    expect(withRegistration('slack')).toEqual(['provider.setup.appRegistration must be an object']);
  });

  it('refuses a definition that is not a JSON object or is too long to travel in a URL', () => {
    expect(withRegistration({ ...slackLike, definition: ['a'] })).toContain('provider.setup.appRegistration.definition must be a JSON object');
    const huge = { blob: 'x'.repeat(PROVIDER_APP_DEFINITION_MAX_LENGTH) };
    expect(withRegistration({ ...slackLike, definition: huge })).toContain(
      `provider.setup.appRegistration.definition is longer than ${PROVIDER_APP_DEFINITION_MAX_LENGTH} characters as JSON`,
    );
  });
});

describe('validateProviderDescriptor: ingress.socket (P-003, D-009)', () => {
  const socket = {
    credential: 'app_token',
    open: { url: 'https://api.example.com/apps.connections.open', urlField: 'url' },
    ackField: 'envelope_id',
    reconnect: { field: 'type', values: ['disconnect'] },
  };
  const base: ProviderDescriptor = {
    id: 'example-chat',
    contractVersion: 1,
    datatypes: ['chat-message'],
    capabilities: ['chat.send', 'ingress.normalize'],
    egressHosts: ['api.example.com'],
    setup: {
      credentials: [
        { key: 'bot_token', label: 'Bot token', hosts: ['api.example.com'] },
        { key: 'app_token', label: 'App token', pattern: 'xapp-[A-Za-z0-9-]+' },
      ],
    },
    ingress: { socket },
  };
  const withSocket = (patch: Record<string, unknown>) =>
    validateProviderDescriptor({ ...base, ingress: { socket: { ...socket, ...patch } } } as unknown as ProviderDescriptor);

  it('accepts a socket opened with a host-only setup credential, with or without ack and reconnect rules', () => {
    expect(validateProviderDescriptor(base)).toEqual([]);
    expect(validateProviderDescriptor({ ...base, ingress: { socket: { credential: 'app_token', open: { url: socket.open.url, method: 'GET', urlField: 'data.socket.url' } } } })).toEqual([]);
    expect(withSocket({ immediate: { field: 'type', values: ['interactive'] } })).toEqual([]);
    expect(PROVIDER_INGRESS_NORMALIZE_CAPABILITY).toBe('ingress.normalize');
  });

  it('refuses a credential that is not a declared setup field, including when the provider declares no setup', () => {
    expect(withSocket({ credential: 'signing_secret' })).toContain(
      "provider.ingress.socket.credential 'signing_secret' is not a provider.setup.credentials key",
    );
    expect(withSocket({ credential: '' })).toContain('provider.ingress.socket.credential must name a provider.setup.credentials key');
    expect(validateProviderDescriptor({ ...base, setup: undefined })).toContain(
      "provider.ingress.socket.credential 'app_token' is not a provider.setup.credentials key",
    );
  });

  it('refuses an open URL that is not https or whose host is outside egressHosts', () => {
    expect(withSocket({ open: { ...socket.open, url: 'http://api.example.com/open' } })).toContain('provider.ingress.socket.open.url must be an https URL');
    expect(withSocket({ open: { ...socket.open, url: 'https://evil.example.net/open' } })).toContain(
      "provider.ingress.socket.open.url host 'evil.example.net' is not in provider.egressHosts",
    );
    expect(withSocket({ open: { ...socket.open, method: 'PUT' } })).toContain('provider.ingress.socket.open.method must be GET or POST');
    expect(withSocket({ open: { url: socket.open.url } })).toContain('provider.ingress.socket.open.urlField must be a dot path to the socket URL in the response');
    expect(withSocket({ open: undefined })).toContain('provider.ingress.socket.open must be an object');
  });

  it('refuses a socket ingress whose provider does not declare ingress.normalize', () => {
    expect(validateProviderDescriptor({ ...base, capabilities: ['chat.send'] })).toEqual([
      'provider.ingress.socket needs capability ingress.normalize',
    ]);
  });

  it('refuses malformed ack and reconnect fields, a carried token and an unknown ingress kind', () => {
    expect(withSocket({ ackField: 'envelope.id' })).toContain('provider.ingress.socket.ackField must be a top-level envelope field name');
    expect(withSocket({ reconnect: { field: 'type', values: [] } })).toContain('provider.ingress.socket.reconnect.values must list at least one value');
    expect(withSocket({ reconnect: { field: 'type', values: ['disconnect', 'disconnect'] } })).toContain(
      'provider.ingress.socket.reconnect.values repeats "disconnect"',
    );
    expect(withSocket({ reconnect: { values: ['disconnect'] } })).toContain('provider.ingress.socket.reconnect.field must be a top-level envelope field name');
    // `immediate` is held to the same envelope-match rules as `reconnect`.
    expect(withSocket({ immediate: ['interactive'] })).toContain('provider.ingress.socket.immediate must be an object');
    expect(withSocket({ immediate: { field: 'payload.type', values: ['interactive'] } })).toContain(
      'provider.ingress.socket.immediate.field must be a top-level envelope field name',
    );
    expect(withSocket({ immediate: { field: 'type', values: [''] } })).toContain('provider.ingress.socket.immediate.values must list at least one value');
    expect(withSocket({ immediate: { field: 'type', values: ['interactive', 'interactive'] } })).toContain(
      'provider.ingress.socket.immediate.values repeats "interactive"',
    );
    expect(withSocket({ token: 'xapp-1-abc' })).toContain(
      'provider.ingress.socket.token is not allowed: a descriptor never carries a credential value',
    );
    expect(validateProviderDescriptor({ ...base, ingress: { socket, webhook: {} } } as unknown as ProviderDescriptor)).toContain(
      'provider.ingress.webhook is not a known ingress kind (known: socket)',
    );
    expect(validateProviderDescriptor({ ...base, ingress: 'socket' } as unknown as ProviderDescriptor)).toEqual(['provider.ingress must be an object']);
    expect(validateProviderDescriptor({ ...base, ingress: {} } as unknown as ProviderDescriptor)).toEqual(['provider.ingress.socket must be an object']);
  });
});

describe('provider option sources (P-004, D-005)', () => {
  it('reads an x-options source off a schema property and ignores a malformed one', () => {
    expect(providerOptionSourceOf({ type: 'string', 'x-options': { capability: 'chat.channels' } }))
      .toEqual({ capability: 'chat.channels' });
    expect(providerOptionSourceOf({ type: 'string', 'x-options': { capability: 'ticket.containers', args: { kind: 'project' } } }))
      .toEqual({ capability: 'ticket.containers', args: { kind: 'project' } });
    expect(providerOptionSourceOf({ type: 'string' })).toBeNull();
    expect(providerOptionSourceOf({ type: 'string', 'x-options': { capability: 'chat.channels.list' } })).toBeNull();
  });

  it('keeps the documented option shape, dropping malformed and repeated entries', () => {
    expect(normalizeProviderOptions({
      options: [
        { value: 'C1', label: '#general', description: 'Company-wide' },
        { value: 'C2' },
        { value: 'C1', label: 'duplicate' },
        { label: 'no value' },
        'not an object',
      ],
    })).toEqual({
      options: [
        { value: 'C1', label: '#general', description: 'Company-wide' },
        { value: 'C2', label: 'C2' },
      ],
      truncated: false,
    });
  });

  it('reads the ticket.containers result as options without the provider changing', () => {
    expect(normalizeProviderOptions({
      containers: [{ id: '120', name: 'Bugs', kind: 'project', sections: [] }, { id: '121', kind: 'project' }],
      truncated: true,
    })).toEqual({ options: [{ value: '120', label: 'Bugs' }, { value: '121', label: '121' }], truncated: true });
  });

  it('caps the list and reports it as truncated', () => {
    const many = Array.from({ length: PROVIDER_OPTIONS_MAX + 5 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
    const list = normalizeProviderOptions({ options: many });
    expect(list.options).toHaveLength(PROVIDER_OPTIONS_MAX);
    expect(list.truncated).toBe(true);
    expect(normalizeProviderOptions(null)).toEqual({ options: [], truncated: false });
  });
});
