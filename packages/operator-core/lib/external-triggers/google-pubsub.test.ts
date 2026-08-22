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
