import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgeGoogleGmailNotifications,
  GMAIL_PUSH_PUBLISHER,
  googleGmailSubscriptionId,
  provisionGoogleGmailPubSub,
  pullGoogleGmailNotifications,
} from './google-pubsub';

const INPUT = {
  workspaceId: 'papercusp-workspace',
  projectId: 'active-alcove-504205-q3',
  serviceAccountPath: '/credential.json',
};
const SUBSCRIPTION_ID = googleGmailSubscriptionId(INPUT.workspaceId);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Read the authorization header whichever shape the transport used. gaxios
 * normalizes request headers into a `Headers` instance before calling
 * `fetchImplementation`, where the hand-rolled layer passed the plain object
 * straight through — so a plain-object read alone silently returns undefined
 * and an assertion built on it reports "no token" for a request that carries
 * one. Accepting every shape pins the TOKEN rather than the transport's
 * internal header representation.
 */
function authHeaderOf(init?: RequestInit): string | null | undefined {
  const headers = init?.headers;
  if (headers instanceof Headers) return headers.get('authorization');
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  }
  return (headers as Record<string, string> | undefined)?.authorization;
}

describe('provisionGoogleGmailPubSub', () => {
  it('creates missing resources and grants the Gmail publisher', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method;
      if (url.endsWith('/topics/papercusp-gmail-push') && method === 'GET') return json({}, 404);
      if (url.endsWith('/topics/papercusp-gmail-push') && method === 'PUT') {
        return json({ name: 'projects/active-alcove-504205-q3/topics/papercusp-gmail-push' });
      }
      // Method-aware ON PURPOSE (WI-41682): Pub/Sub routes topics.getIamPolicy
      // as a GET, and a double that answers any verb cannot tell a correct call
      // from the POST that silently 404s against the real API.
      if (url.endsWith(':getIamPolicy') && method === 'GET') return json({ etag: 'etag', bindings: [] });
      if (url.endsWith(':setIamPolicy') && method === 'POST') {
        return json(JSON.parse(String(init?.body)).policy);
      }
      if (url.endsWith(`/subscriptions/${SUBSCRIPTION_ID}`) && method === 'GET') return json({}, 404);
      if (url.endsWith(`/subscriptions/${SUBSCRIPTION_ID}`) && method === 'PUT') {
        return json({ name: `projects/active-alcove-504205-q3/subscriptions/${SUBSCRIPTION_ID}` });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    const result = await provisionGoogleGmailPubSub(INPUT, {
      fetch: fetchMock as typeof fetch,
      getAccessToken: async () => 'access-token',
    });

    expect(result).toMatchObject({
      subscriptionId: SUBSCRIPTION_ID,
      topic: 'created',
      subscription: 'created',
      publisherGrant: 'added',
    });
    // WI-41682: the real API routes topics.getIamPolicy as a GET only. A POST
    // 404s against an HTML error page, which request() folds into its 404 branch
    // and reports as a missing policy — so pin the verb, and the absent body.
    const getPolicyCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith(':getIamPolicy'));
    expect(getPolicyCall?.[1]?.method).toBe('GET');
    expect(getPolicyCall?.[1]?.body).toBeUndefined();

    const setPolicyCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith(':setIamPolicy'));
    const setPolicy = JSON.parse(String(setPolicyCall?.[1]?.body));
    expect(setPolicy.policy.bindings).toContainEqual({
      role: 'roles/pubsub.publisher',
      members: [GMAIL_PUSH_PUBLISHER],
    });
    const subscriptionCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/subscriptions/') && init?.method === 'PUT',
    );
    expect(JSON.parse(String(subscriptionCall?.[1]?.body))).toEqual({
      topic: 'projects/active-alcove-504205-q3/topics/papercusp-gmail-push',
      ackDeadlineSeconds: 60,
    });
    // Still the exact bearer on EVERY request, not merely a header that exists:
    // a calibrated probe confirmed the token survived the gaxios swap and only
    // the header's READ shape changed (see authHeaderOf above).
    expect(
      fetchMock.mock.calls.every(([, init]) => authHeaderOf(init) === 'Bearer access-token'),
    ).toBe(true);
  });

  it('is a no-op when topic, grant, and correctly-wired subscription already exist', async () => {
    const topicName = 'projects/active-alcove-504205-q3/topics/papercusp-gmail-push';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(':getIamPolicy') && init?.method === 'GET') {
        return json({ bindings: [{ role: 'roles/pubsub.publisher', members: [GMAIL_PUSH_PUBLISHER] }] });
      }
      if (url.includes('/subscriptions/')) return json({ topic: topicName });
      if (url.includes('/topics/') && init?.method === 'GET') return json({ name: topicName });
      throw new Error(`unexpected mutation ${init?.method} ${url}`);
    });

    const result = await provisionGoogleGmailPubSub(INPUT, {
      fetch: fetchMock as typeof fetch,
      getAccessToken: async () => 'access-token',
    });

    expect(result).toMatchObject({ topic: 'existing', subscription: 'existing', publisherGrant: 'existing' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports an unroutable getIamPolicy instead of blaming a missing policy', async () => {
    // Reproduces the live WI-41682 failure: the topic exists, but the policy
    // read 404s. Because the topic provably exists by that point, and an empty
    // policy answers 200 with an etag, a 404 can only mean the request never
    // reached topics.getIamPolicy — the error must say so rather than assert
    // something false about the policy itself.
    const topicName = 'projects/active-alcove-504205-q3/topics/papercusp-gmail-push';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(':getIamPolicy')) return json({}, 404);
      if (url.includes('/topics/') && init?.method === 'GET') return json({ name: topicName });
      throw new Error(`unexpected request ${init?.method} ${url}`);
    });

    await expect(
      provisionGoogleGmailPubSub(INPUT, {
        fetch: fetchMock as typeof fetch,
        getAccessToken: async () => 'access-token',
      }),
    ).rejects.toThrow(/get_topic_iam_policy_unroutable/);
  });

  it('fails closed when an existing subscription points at another topic', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(':getIamPolicy') && init?.method === 'GET') {
        return json({ bindings: [{ role: 'roles/pubsub.publisher', members: [GMAIL_PUSH_PUBLISHER] }] });
      }
      if (url.includes('/subscriptions/')) {
        return json({ topic: 'projects/active-alcove-504205-q3/topics/someone-elses-topic' });
      }
      if (url.includes('/topics/') && init?.method === 'GET') return json({ name: 'topic' });
      throw new Error(`unexpected request ${init?.method} ${url}`);
    });

    await expect(
      provisionGoogleGmailPubSub(INPUT, {
        fetch: fetchMock as typeof fetch,
        getAccessToken: async () => 'access-token',
      }),
    ).rejects.toThrow(/subscription_topic_mismatch/);
  });

  it('derives a distinct deterministic subscription for each workspace', () => {
    expect(googleGmailSubscriptionId('workspace-a')).toBe(googleGmailSubscriptionId('workspace-a'));
    expect(googleGmailSubscriptionId('workspace-a')).not.toBe(googleGmailSubscriptionId('workspace-b'));
    expect(googleGmailSubscriptionId('Workspace With Spaces')).toMatch(/^papercusp-gmail-pull-/);
  });

  it('pulls a bounded batch and acknowledges only the supplied unique ack ids', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(':pull')) {
        expect(JSON.parse(String(init?.body))).toEqual({ maxMessages: 25, returnImmediately: true });
        return json({
          receivedMessages: [
            { ackId: 'ack-1', message: { data: 'eyJlbWFpbEFkZHJlc3MiOiJhQGIuY29tIn0=' } },
            { message: { data: 'invalid-without-ack-id' } },
          ],
        });
      }
      if (url.endsWith(':acknowledge')) {
        expect(JSON.parse(String(init?.body))).toEqual({ ackIds: ['ack-1', 'ack-2'] });
        return json({});
      }
      throw new Error(`unexpected request ${init?.method} ${url}`);
    });
    const deps = {
      fetch: fetchMock as typeof fetch,
      getAccessToken: async () => 'access-token',
    };

    await expect(pullGoogleGmailNotifications({ ...INPUT, maxMessages: 25 }, deps)).resolves.toEqual([
      { ackId: 'ack-1', message: { data: 'eyJlbWFpbEFkZHJlc3MiOiJhQGIuY29tIn0=' } },
    ]);
    await expect(acknowledgeGoogleGmailNotifications(INPUT, ['ack-1', 'ack-2', 'ack-1'], deps)).resolves.toBe(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes(SUBSCRIPTION_ID))).toBe(true);
  });
});

describe('Pub/Sub authorization failures name the denied principal', () => {
  /**
   * Regression guard for WI-41639. Google answers an unauthorized Pub/Sub call
   * with a bare "User not authorized to perform this action." naming no
   * principal, which is indistinguishable from an expired *user* login — the
   * ambiguity that left Gmail trigger source 62b7f9e2 degraded for ~12h under a
   * wall that offered "interactive gcloud reauth OR a Pub/Sub grant" as equal
   * options. Only the grant is real: this provisioner authenticates as the
   * GOOGLE_APPLICATION_CREDENTIALS service account and never touches gcloud.
   */
  async function withKeyFile<T>(
    body: (path: string) => Promise<T>,
    key: Record<string, unknown> = {
      project_id: 'active-alcove-504205-q3',
      client_email: 'omp-vertex@active-alcove-504205-q3.iam.gserviceaccount.com',
    },
  ): Promise<T> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'pubsub-key-'));
    const path = join(dir, 'sa.json');
    await fs.writeFile(path, JSON.stringify(key), 'utf8');
    try {
      return await body(path);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  function denying(status: number) {
    return vi.fn(async () =>
      json({ error: { message: 'User not authorized to perform this action.' } }, status),
    );
  }

  it('appends principal, project, permission, and the exact grant to a 403', async () => {
    const message = await withKeyFile(async (serviceAccountPath) => {
      const error = await provisionGoogleGmailPubSub(
        { ...INPUT, serviceAccountPath },
        { fetch: denying(403) as unknown as typeof fetch, getAccessToken: async () => 'access-token' },
      ).catch((caught: unknown) => caught as Error);
      return (error as Error).message;
    });

    // Prefix preserved byte-for-byte so existing matchers keep working.
    expect(message.startsWith('google_pubsub_get_topic_403:User not authorized to perform this action.')).toBe(true);
    expect(message).toContain('denied_principal=omp-vertex@active-alcove-504205-q3.iam.gserviceaccount.com');
    expect(message).toContain('project=active-alcove-504205-q3');
    expect(message).toContain('missing_permission=pubsub.topics.get');
    expect(message).toContain('required_role=roles/pubsub.admin');
    expect(message).toContain('--role=roles/pubsub.admin');
  });

  it('leaves non-authorization failures untouched', async () => {
    const message = await withKeyFile(async (serviceAccountPath) => {
      const error = await provisionGoogleGmailPubSub(
        { ...INPUT, serviceAccountPath },
        { fetch: denying(503) as unknown as typeof fetch, getAccessToken: async () => 'access-token' },
      ).catch((caught: unknown) => caught as Error);
      return (error as Error).message;
    });

    expect(message).toContain('google_pubsub_get_topic_503');
    expect(message).not.toContain('denied_principal');
    expect(message).not.toContain('required_role');
  });

  it('still reports a 403 when the key file has no client_email', async () => {
    const message = await withKeyFile(
      async (serviceAccountPath) => {
        const error = await provisionGoogleGmailPubSub(
          { ...INPUT, serviceAccountPath },
          { fetch: denying(403) as unknown as typeof fetch, getAccessToken: async () => 'access-token' },
        ).catch((caught: unknown) => caught as Error);
        return (error as Error).message;
      },
      { project_id: 'active-alcove-504205-q3' },
    );

    expect(message).toContain('denied_principal=unresolved');
    expect(message).toContain('required_role=roles/pubsub.admin');
  });

  it('does not require a readable key file when the caller supplies projectId', async () => {
    const error = await provisionGoogleGmailPubSub(INPUT, {
      fetch: denying(403) as unknown as typeof fetch,
      getAccessToken: async () => 'access-token',
    }).catch((caught: unknown) => caught as Error);

    // INPUT.serviceAccountPath is deliberately nonexistent: the identity read is
    // best-effort, so provisioning still reaches the API and fails on the 403.
    expect((error as Error).message).toContain('google_pubsub_get_topic_403');
    expect((error as Error).message).toContain('denied_principal=unresolved');
  });
});

/**
 * WI-474688. bg-host is BOTH the DBOS routines primary (where google-gmail-poll runs) and a
 * workspace-host provisioning host, and provisioning refuses service-account keys — so its unit
 * unsets GOOGLE_APPLICATION_CREDENTIALS on purpose. Before the dedicated variable existed that
 * unset also took Pub/Sub's only credential path, and both Gmail sources sat degraded on
 * `google_pubsub_service_account_path_required` while the topic, its publisher binding and the
 * pull subscription were all already provisioned.
 *
 * The first case below is that exact production shape: ADC absent, dedicated variable present.
 * It must resolve, and it must resolve to the DEDICATED path — asserting only "did not throw"
 * would still pass if the fallback silently reached for something else.
 */
describe('Pub/Sub credential precedence survives an ADC-free process', () => {
  /** Run with an exact env shape, restoring whatever the ambient process had. */
  async function withEnv<T>(
    env: { adc?: string; dedicated?: string },
    run: () => Promise<T>,
  ): Promise<T> {
    const prior = {
      adc: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      dedicated: process.env.PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH,
    };
    const apply = (adc?: string, dedicated?: string) => {
      if (adc === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
      if (dedicated === undefined) delete process.env.PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH;
      else process.env.PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH = dedicated;
    };
    apply(env.adc, env.dedicated);
    try {
      return await run();
    } finally {
      apply(prior.adc, prior.dedicated);
    }
  }

  /** Resolve the key path the layer actually used, via the token minter that receives it. */
  async function resolvedPath(input: {
    workspaceId: string;
    projectId: string;
    serviceAccountPath?: string;
  }): Promise<string | Error> {
    const seen: string[] = [];
    const error = await provisionGoogleGmailPubSub(input, {
      fetch: (async () => json({}, 403)) as unknown as typeof fetch,
      getAccessToken: async (path: string) => {
        seen.push(path);
        return 'access-token';
      },
    }).catch((caught: unknown) => caught as Error);
    // Every call here ends on the 403 double; what is under test is the path that got there.
    if (seen.length === 0) return error as Error;
    return seen[0];
  }

  const base = { workspaceId: INPUT.workspaceId, projectId: INPUT.projectId };

  it('uses the dedicated variable when ADC is unset, as it is on bg-host', async () => {
    const used = await withEnv({ adc: undefined, dedicated: '/dedicated-pubsub.json' }, () =>
      resolvedPath(base),
    );
    expect(used).toBe('/dedicated-pubsub.json');
  });

  it('prefers the dedicated variable over ADC when both are set', async () => {
    const used = await withEnv({ adc: '/adc.json', dedicated: '/dedicated-pubsub.json' }, () =>
      resolvedPath(base),
    );
    expect(used).toBe('/dedicated-pubsub.json');
  });

  it('still falls back to ADC where no dedicated variable is set', async () => {
    const used = await withEnv({ adc: '/adc.json', dedicated: undefined }, () => resolvedPath(base));
    expect(used).toBe('/adc.json');
  });

  it('lets an explicit caller path win over both variables', async () => {
    const used = await withEnv({ adc: '/adc.json', dedicated: '/dedicated-pubsub.json' }, () =>
      resolvedPath({ ...base, serviceAccountPath: '/explicit.json' }),
    );
    expect(used).toBe('/explicit.json');
  });

  it('still refuses when neither variable is set and no path is supplied', async () => {
    const used = await withEnv({ adc: undefined, dedicated: undefined }, () => resolvedPath(base));
    expect(used).toBeInstanceOf(Error);
    expect((used as Error).message).toBe('google_pubsub_service_account_path_required');
  });
});
