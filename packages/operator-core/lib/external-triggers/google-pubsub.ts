/**
 * Idempotent Google Pub/Sub provisioning for Gmail push notifications.
 *
 * The existing Vertex service account is used only for GCP control-plane
 * operations. User mailbox access remains on the Desktop OAuth provider. The
 * provisioner uses google-auth-library for a short-lived bearer token and the
 * Pub/Sub REST API, avoiding gcloud and a second Google SDK dependency.
 */
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';

export const GMAIL_PUSH_PUBLISHER = 'serviceAccount:gmail-api-push@system.gserviceaccount.com';
export const PUBSUB_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const DEFAULT_TOPIC_ID = 'papercusp-gmail-push';
const DEFAULT_SUBSCRIPTION_ID = 'papercusp-gmail-pull';
const PUBSUB_API_ORIGIN = 'https://pubsub.googleapis.com';
const RESOURCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~+%:-]{0,254}$/;
const requireCjs = createRequire(import.meta.url);

export interface GooglePubSubProvisionInput {
  /** Defaults to project_id in the service-account JSON. */
  projectId?: string;
  /** Defaults to GOOGLE_APPLICATION_CREDENTIALS. */
  serviceAccountPath?: string;
  topicId?: string;
  subscriptionId?: string;
  ackDeadlineSeconds?: number;
}

export interface GooglePubSubProvisionResult {
  projectId: string;
  topicName: string;
  subscriptionName: string;
  topic: 'created' | 'existing';
  subscription: 'created' | 'existing';
  publisherGrant: 'added' | 'existing';
}

export interface GooglePubSubProvisionDeps {
  fetch?: typeof fetch;
  getAccessToken?: (serviceAccountPath: string) => Promise<string>;
  apiOrigin?: string;
}

interface IamBinding {
  role: string;
  members?: string[];
  condition?: unknown;
}

interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: IamBinding[];
}

function resourceSegment(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized || !RESOURCE_SEGMENT.test(normalized) || normalized.includes('/')) {
    throw new Error(`google_pubsub_invalid_${field}`);
  }
  return normalized;
}

function serviceAccountPath(input?: string): string {
  const path = input?.trim() || process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!path) throw new Error('google_pubsub_service_account_path_required');
  return path;
}

async function projectIdFromServiceAccount(path: string): Promise<string> {
  const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as { project_id?: string };
  return resourceSegment(parsed.project_id, 'project_id');
}

async function defaultAccessToken(path: string): Promise<string> {
  // Lazy CJS interop matches the existing FCM credential path and keeps the
  // auth package out of processes that never provision Google resources.
  const { GoogleAuth } = requireCjs('google-auth-library') as typeof import('google-auth-library');
  const auth = new GoogleAuth({ keyFilename: path, scopes: [PUBSUB_CLOUD_PLATFORM_SCOPE] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('google_pubsub_access_token_empty');
  return token;
}

async function responseJson<T>(response: Response, operation: string): Promise<T> {
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const providerMessage =
      payload && typeof payload === 'object'
        ? ((payload as { error?: { message?: string }; message?: string }).error?.message ??
          (payload as { message?: string }).message)
        : undefined;
    throw new Error(`google_pubsub_${operation}_${response.status}${providerMessage ? `:${providerMessage}` : ''}`);
  }
  return payload as T;
}

function authHeaders(token: string, body: unknown): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
}

async function request<T>(
  fetchImpl: typeof fetch,
  token: string,
  operation: string,
  url: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; value: T | null }> {
  const response = await fetchImpl(url, {
    method,
    headers: authHeaders(token, body),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 404) return { status: 404, value: null };
  return { status: response.status, value: await responseJson<T>(response, operation) };
}

function withGmailPublisher(policy: IamPolicy): { policy: IamPolicy; changed: boolean } {
  const bindings = (policy.bindings ?? []).map((binding) => ({
    ...binding,
    members: [...(binding.members ?? [])],
  }));
  let publisher = bindings.find(
    (binding) => binding.role === 'roles/pubsub.publisher' && binding.condition === undefined,
  );
  if (!publisher) {
    publisher = { role: 'roles/pubsub.publisher', members: [] };
    bindings.push(publisher);
  }
  if (publisher.members!.includes(GMAIL_PUSH_PUBLISHER)) {
    return { policy: { ...policy, bindings }, changed: false };
  }
  publisher.members!.push(GMAIL_PUSH_PUBLISHER);
  publisher.members!.sort();
  return { policy: { ...policy, bindings }, changed: true };
}

/**
 * Ensure the Gmail topic, publisher IAM binding, and pull subscription exist.
 * Existing resources are read and validated; a subscription pointing at a
 * different topic fails closed instead of being silently repurposed.
 */
export async function provisionGoogleGmailPubSub(
  input: GooglePubSubProvisionInput,
  deps: GooglePubSubProvisionDeps = {},
): Promise<GooglePubSubProvisionResult> {
  const credentialPath = serviceAccountPath(input.serviceAccountPath);
  const projectId = resourceSegment(
    input.projectId ?? (await projectIdFromServiceAccount(credentialPath)),
    'project_id',
  );
  const topicId = resourceSegment(input.topicId ?? DEFAULT_TOPIC_ID, 'topic_id');
  const subscriptionId = resourceSegment(input.subscriptionId ?? DEFAULT_SUBSCRIPTION_ID, 'subscription_id');
  const ackDeadlineSeconds = input.ackDeadlineSeconds ?? 60;
  if (!Number.isInteger(ackDeadlineSeconds) || ackDeadlineSeconds < 10 || ackDeadlineSeconds > 600) {
    throw new Error('google_pubsub_invalid_ack_deadline_seconds');
  }

  const getAccessToken = deps.getAccessToken ?? defaultAccessToken;
  const token = await getAccessToken(credentialPath);
  const fetchImpl = deps.fetch ?? fetch;
  const origin = (deps.apiOrigin ?? PUBSUB_API_ORIGIN).replace(/\/$/, '');
  const projectSegment = encodeURIComponent(projectId);
  const topicSegment = encodeURIComponent(topicId);
  const subscriptionSegment = encodeURIComponent(subscriptionId);
  const topicName = `projects/${projectId}/topics/${topicId}`;
  const subscriptionName = `projects/${projectId}/subscriptions/${subscriptionId}`;
  const topicUrl = `${origin}/v1/projects/${projectSegment}/topics/${topicSegment}`;
  const subscriptionUrl = `${origin}/v1/projects/${projectSegment}/subscriptions/${subscriptionSegment}`;

  const existingTopic = await request<{ name: string }>(fetchImpl, token, 'get_topic', topicUrl, 'GET');
  let topic: GooglePubSubProvisionResult['topic'] = 'existing';
  if (existingTopic.status === 404) {
    await request(fetchImpl, token, 'create_topic', topicUrl, 'PUT', {});
    topic = 'created';
  }

  const policyResult = await request<IamPolicy>(
    fetchImpl,
    token,
    'get_topic_iam_policy',
    `${topicUrl}:getIamPolicy`,
    'POST',
    {},
  );
  if (!policyResult.value) throw new Error('google_pubsub_topic_iam_policy_missing');
  const merged = withGmailPublisher(policyResult.value);
  let publisherGrant: GooglePubSubProvisionResult['publisherGrant'] = 'existing';
  if (merged.changed) {
    await request(fetchImpl, token, 'set_topic_iam_policy', `${topicUrl}:setIamPolicy`, 'POST', {
      policy: merged.policy,
    });
    publisherGrant = 'added';
  }

  const existingSubscription = await request<{ name: string; topic?: string }>(
    fetchImpl,
    token,
    'get_subscription',
    subscriptionUrl,
    'GET',
  );
  let subscription: GooglePubSubProvisionResult['subscription'] = 'existing';
  if (existingSubscription.status === 404) {
    await request(fetchImpl, token, 'create_subscription', subscriptionUrl, 'PUT', {
      topic: topicName,
      ackDeadlineSeconds,
    });
    subscription = 'created';
  } else if (existingSubscription.value?.topic !== topicName) {
    throw new Error(`google_pubsub_subscription_topic_mismatch:${existingSubscription.value?.topic ?? 'unset'}`);
  }

  return { projectId, topicName, subscriptionName, topic, subscription, publisherGrant };
}
