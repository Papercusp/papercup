/**
 * Idempotent Google Pub/Sub provisioning for Gmail push notifications.
 *
 * The existing Vertex service account is used only for GCP control-plane
 * operations. User mailbox access remains on the Desktop OAuth provider. The
 * provisioner uses google-auth-library for a short-lived bearer token and the
 * Pub/Sub REST API, avoiding gcloud and a second Google SDK dependency.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';

export const GMAIL_PUSH_PUBLISHER = 'serviceAccount:gmail-api-push@system.gserviceaccount.com';
export const PUBSUB_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const DEFAULT_TOPIC_ID = 'papercusp-gmail-push';
const PUBSUB_API_ORIGIN = 'https://pubsub.googleapis.com';
const RESOURCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~+%:-]{0,254}$/;
const requireCjs = createRequire(import.meta.url);

export interface GooglePubSubProvisionInput {
  /** Every workspace gets an independent pull subscription on the shared topic. */
  workspaceId: string;
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
  subscriptionId: string;
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

export interface GooglePubSubReceivedMessage {
  ackId: string;
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
}

export interface GooglePubSubPullInput extends GooglePubSubProvisionInput {
  maxMessages?: number;
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

/** Stable, collision-resistant subscription id for one workspace. */
export function googleGmailSubscriptionId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!normalized) throw new Error('google_pubsub_invalid_workspace_id');
  const readable =
    normalized
      .toLowerCase()
      .replace(/[^a-z0-9._~+%-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200) || 'workspace';
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return resourceSegment(`papercusp-gmail-pull-${readable}-${digest}`, 'subscription_id');
}

function serviceAccountPath(input?: string): string {
  const path = input?.trim() || process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!path) throw new Error('google_pubsub_service_account_path_required');
  return path;
}

interface ServiceAccountIdentity {
  projectId: string | null;
  /** `client_email` from the key file — the principal every 401/403 below is really about. */
  principal: string | null;
}

/**
 * Read project + principal from the key file.
 *
 * `required` is true only when the caller supplied no explicit `projectId` and
 * the file is therefore load-bearing. Otherwise the read is best-effort: the
 * principal is wanted purely to make a 403 legible, and a caller that passed its
 * own project must not start failing because a key file is unreadable.
 */
async function serviceAccountIdentity(
  path: string,
  required: boolean,
): Promise<ServiceAccountIdentity> {
  let parsed: { project_id?: string; client_email?: string };
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf8')) as typeof parsed;
  } catch (error) {
    if (required) throw error;
    return { projectId: null, principal: null };
  }
  const principal = parsed.client_email?.trim();
  const projectId = parsed.project_id?.trim();
  return {
    projectId: projectId && projectId.length > 0 ? projectId : null,
    principal: principal && principal.length > 0 ? principal : null,
  };
}

/**
 * The Pub/Sub permission each REST call actually consumes.
 *
 * Google answers every one of them with the same opaque "User not authorized to
 * perform this action." and never names the denied principal, so a 403 here is
 * indistinguishable from an expired user login unless we say which identity was
 * used. `set_topic_iam_policy` is the reason the grant must be `roles/pubsub.admin`
 * rather than `roles/pubsub.editor` — editor confers no `setIamPolicy`.
 */
const PUBSUB_OPERATION_PERMISSIONS: Readonly<Record<string, string>> = {
  get_topic: 'pubsub.topics.get',
  create_topic: 'pubsub.topics.create',
  get_topic_iam_policy: 'pubsub.topics.getIamPolicy',
  set_topic_iam_policy: 'pubsub.topics.setIamPolicy',
  get_subscription: 'pubsub.subscriptions.get',
  create_subscription: 'pubsub.subscriptions.create',
  pull: 'pubsub.subscriptions.consume',
  acknowledge: 'pubsub.subscriptions.consume',
};

/** Role that grants every permission in the map above. */
export const PUBSUB_REQUIRED_ROLE = 'roles/pubsub.admin';

interface PubSubAuthContext {
  token: string;
  principal: string | null;
  projectId: string;
  credentialPath: string;
}

/**
 * Turn an opaque 401/403 into the one line an operator can act on: which
 * principal was denied, where that principal came from, and the exact grant.
 */
export function describePubSubAuthFailure(
  operation: string,
  auth: Pick<PubSubAuthContext, 'principal' | 'projectId' | 'credentialPath'>,
): string {
  const permission = PUBSUB_OPERATION_PERMISSIONS[operation];
  const principal = auth.principal ?? `unresolved (no client_email in ${auth.credentialPath})`;
  return (
    ` [denied_principal=${principal}` +
    ` project=${auth.projectId}` +
    (permission ? ` missing_permission=${permission}` : '') +
    ` required_role=${PUBSUB_REQUIRED_ROLE}` +
    ` credential_source=GOOGLE_APPLICATION_CREDENTIALS=${auth.credentialPath}` +
    ` fix=gcloud projects add-iam-policy-binding ${auth.projectId}` +
    ` --member=serviceAccount:${auth.principal ?? '<client_email>'}` +
    ` --role=${PUBSUB_REQUIRED_ROLE}]`
  );
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

async function runtimeContext(
  input: GooglePubSubProvisionInput,
  deps: GooglePubSubProvisionDeps,
): Promise<{
  projectId: string;
  subscriptionId: string;
  auth: PubSubAuthContext;
  fetchImpl: typeof fetch;
  origin: string;
}> {
  const credentialPath = serviceAccountPath(input.serviceAccountPath);
  const identity = await serviceAccountIdentity(credentialPath, !input.projectId?.trim());
  const projectId = resourceSegment(input.projectId ?? identity.projectId ?? undefined, 'project_id');
  const subscriptionId = resourceSegment(
    input.subscriptionId ?? googleGmailSubscriptionId(input.workspaceId),
    'subscription_id',
  );
  const token = await (deps.getAccessToken ?? defaultAccessToken)(credentialPath);
  return {
    projectId,
    subscriptionId,
    auth: { token, principal: identity.principal, projectId, credentialPath },
    fetchImpl: deps.fetch ?? fetch,
    origin: (deps.apiOrigin ?? PUBSUB_API_ORIGIN).replace(/\/$/, ''),
  };
}

async function responseJson<T>(
  response: Response,
  operation: string,
  auth?: PubSubAuthContext,
): Promise<T> {
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
    // The prefix stays byte-identical so existing matchers keep working; the
    // identity diagnostic is appended only where it is the actual question.
    const diagnostic =
      auth && (response.status === 401 || response.status === 403)
        ? describePubSubAuthFailure(operation, auth)
        : '';
    throw new Error(
      `google_pubsub_${operation}_${response.status}${providerMessage ? `:${providerMessage}` : ''}${diagnostic}`,
    );
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
  auth: PubSubAuthContext,
  operation: string,
  url: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; value: T | null }> {
  const response = await fetchImpl(url, {
    method,
    headers: authHeaders(auth.token, body),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 404) return { status: 404, value: null };
  return { status: response.status, value: await responseJson<T>(response, operation, auth) };
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
  const { projectId, subscriptionId, auth, fetchImpl, origin } = await runtimeContext(input, deps);
  const topicId = resourceSegment(input.topicId ?? DEFAULT_TOPIC_ID, 'topic_id');
  const ackDeadlineSeconds = input.ackDeadlineSeconds ?? 60;
  if (!Number.isInteger(ackDeadlineSeconds) || ackDeadlineSeconds < 10 || ackDeadlineSeconds > 600) {
    throw new Error('google_pubsub_invalid_ack_deadline_seconds');
  }

  const projectSegment = encodeURIComponent(projectId);
  const topicSegment = encodeURIComponent(topicId);
  const subscriptionSegment = encodeURIComponent(subscriptionId);
  const topicName = `projects/${projectId}/topics/${topicId}`;
  const subscriptionName = `projects/${projectId}/subscriptions/${subscriptionId}`;
  const topicUrl = `${origin}/v1/projects/${projectSegment}/topics/${topicSegment}`;
  const subscriptionUrl = `${origin}/v1/projects/${projectSegment}/subscriptions/${subscriptionSegment}`;

  const existingTopic = await request<{ name: string }>(fetchImpl, auth, 'get_topic', topicUrl, 'GET');
  let topic: GooglePubSubProvisionResult['topic'] = 'existing';
  if (existingTopic.status === 404) {
    await request(fetchImpl, auth, 'create_topic', topicUrl, 'PUT', {});
    topic = 'created';
  }

  // Pub/Sub v1 exposes topics.getIamPolicy as a GET; only setIamPolicy is a
  // POST. A POST here matches no API method, so Google answers with its generic
  // HTML 404 page rather than a JSON API error — which request() folds into the
  // 404 branch, producing a falsy value and a domain error about the policy
  // (WI-41682). The verb is load-bearing, not stylistic.
  const policyResult = await request<IamPolicy>(
    fetchImpl,
    auth,
    'get_topic_iam_policy',
    `${topicUrl}:getIamPolicy`,
    'GET',
  );
  // The topic demonstrably exists by this point — it was either fetched above or
  // just created — and a topic with no bindings still answers 200 with an etag.
  // So a 404 here is never "the policy is absent"; it means the request did not
  // reach topics.getIamPolicy at all. Say that, instead of blaming the policy.
  if (!policyResult.value) {
    throw new Error(`google_pubsub_get_topic_iam_policy_unroutable:${topicName}`);
  }
  const merged = withGmailPublisher(policyResult.value);
  let publisherGrant: GooglePubSubProvisionResult['publisherGrant'] = 'existing';
  if (merged.changed) {
    await request(fetchImpl, auth, 'set_topic_iam_policy', `${topicUrl}:setIamPolicy`, 'POST', {
      policy: merged.policy,
    });
    publisherGrant = 'added';
  }

  const existingSubscription = await request<{ name: string; topic?: string }>(
    fetchImpl,
    auth,
    'get_subscription',
    subscriptionUrl,
    'GET',
  );
  let subscription: GooglePubSubProvisionResult['subscription'] = 'existing';
  if (existingSubscription.status === 404) {
    await request(fetchImpl, auth, 'create_subscription', subscriptionUrl, 'PUT', {
      topic: topicName,
      ackDeadlineSeconds,
    });
    subscription = 'created';
  } else if (existingSubscription.value?.topic !== topicName) {
    throw new Error(`google_pubsub_subscription_topic_mismatch:${existingSubscription.value?.topic ?? 'unset'}`);
  }

  return {
    projectId,
    subscriptionId,
    topicName,
    subscriptionName,
    topic,
    subscription,
    publisherGrant,
  };
}

/** Pull a bounded doorbell batch from this workspace's subscription. */
export async function pullGoogleGmailNotifications(
  input: GooglePubSubPullInput,
  deps: GooglePubSubProvisionDeps = {},
): Promise<GooglePubSubReceivedMessage[]> {
  const { projectId, subscriptionId, auth, fetchImpl, origin } = await runtimeContext(input, deps);
  const maxMessages = input.maxMessages ?? 100;
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 1_000) {
    throw new Error('google_pubsub_invalid_max_messages');
  }
  const url =
    `${origin}/v1/projects/${encodeURIComponent(projectId)}` +
    `/subscriptions/${encodeURIComponent(subscriptionId)}:pull`;
  const pulled = await request<{ receivedMessages?: GooglePubSubReceivedMessage[] }>(
    fetchImpl,
    auth,
    'pull',
    url,
    'POST',
    { maxMessages, returnImmediately: true },
  );
  if (pulled.status === 404) throw new Error(`google_pubsub_subscription_missing:${subscriptionId}`);
  return (pulled.value?.receivedMessages ?? []).filter(
    (received): received is GooglePubSubReceivedMessage =>
      typeof received?.ackId === 'string' && received.ackId.length > 0,
  );
}

/** Ack only notifications whose Gmail reconciliation and cursor commit succeeded. */
export async function acknowledgeGoogleGmailNotifications(
  input: GooglePubSubProvisionInput,
  ackIds: string[],
  deps: GooglePubSubProvisionDeps = {},
): Promise<number> {
  const uniqueAckIds = [...new Set(ackIds.filter((ackId) => ackId.trim()))];
  if (uniqueAckIds.length === 0) return 0;
  if (uniqueAckIds.length > 1_000) throw new Error('google_pubsub_too_many_ack_ids');
  const { projectId, subscriptionId, auth, fetchImpl, origin } = await runtimeContext(input, deps);
  const url =
    `${origin}/v1/projects/${encodeURIComponent(projectId)}` +
    `/subscriptions/${encodeURIComponent(subscriptionId)}:acknowledge`;
  const acknowledged = await request(fetchImpl, auth, 'acknowledge', url, 'POST', { ackIds: uniqueAckIds });
  if (acknowledged.status === 404) {
    throw new Error(`google_pubsub_subscription_missing:${subscriptionId}`);
  }
  return uniqueAckIds.length;
}
