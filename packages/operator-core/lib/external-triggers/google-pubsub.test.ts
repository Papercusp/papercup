import { describe, expect, it, vi } from 'vitest';
import { GMAIL_PUSH_PUBLISHER, provisionGoogleGmailPubSub } from './google-pubsub';

const INPUT = {
  projectId: 'active-alcove-504205-q3',
  serviceAccountPath: '/credential.json',
};

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
      if (url.endsWith('/subscriptions/papercusp-gmail-pull') && method === 'GET') return json({}, 404);
      if (url.endsWith('/subscriptions/papercusp-gmail-pull') && method === 'PUT') {
        return json({ name: 'projects/active-alcove-504205-q3/subscriptions/papercusp-gmail-pull' });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    const result = await provisionGoogleGmailPubSub(INPUT, {
      fetch: fetchMock as typeof fetch,
      getAccessToken: async () => 'access-token',
    });

    expect(result).toMatchObject({ topic: 'created', subscription: 'created', publisherGrant: 'added' });
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
});
