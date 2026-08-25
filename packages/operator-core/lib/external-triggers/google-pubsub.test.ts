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

describe('provisionGoogleGmailPubSub', () => {
  it('creates missing resources and grants the Gmail publisher', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method;
      if (url.endsWith('/topics/papercusp-gmail-push') && method === 'GET') return json({}, 404);
      if (url.endsWith('/topics/papercusp-gmail-push') && method === 'PUT') {
        return json({ name: 'projects/active-alcove-504205-q3/topics/papercusp-gmail-push' });
      }
      if (url.endsWith(':getIamPolicy')) return json({ etag: 'etag', bindings: [] });
      if (url.endsWith(':setIamPolicy')) return json(JSON.parse(String(init?.body)).policy);
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
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => (init?.headers as Record<string, string>).authorization === 'Bearer access-token',
      ),
    ).toBe(true);
  });

  it('is a no-op when topic, grant, and correctly-wired subscription already exist', async () => {
    const topicName = 'projects/active-alcove-504205-q3/topics/papercusp-gmail-push';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(':getIamPolicy')) {
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

  it('fails closed when an existing subscription points at another topic', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(':getIamPolicy')) {
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
