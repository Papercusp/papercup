/**
 * APNs + FCM dispatcher. Sends a push to every registered device when:
 *   - A harness escalates (intervention required)
 *   - A smoke test fails
 *   - User-defined notification rules fire (future)
 *
 * Registered tokens live in harness_shared.mobile_push_tokens (migration 009).
 *
 * Provider selection:
 *   - APNs: HTTP/2 to api.push.apple.com using a P8 auth key
 *   - FCM: HTTP v1 to fcm.googleapis.com using a service-account JWT
 *
 * Credentials are USER-PROVIDED (paste into Settings → Mobile → Push Credentials).
 * That keeps push privacy-respecting: payload contents never traverse anyone
 * else's infra. Push tokens themselves go through APNs/FCM by definition; that's
 * unavoidable on iOS/Android.
 */
import { request } from 'node:https';

/**
 * Push-routing kinds understood by the mobile app's `push-routing.ts`.
 * Keep in sync there. New kinds default to opening the Notifications screen.
 */
export type PushKind =
  | 'intervention'
  | 'smoke-fail'
  | 'operator-suggestion';

interface PushPayload {
  /** Short title shown on lock screen */
  title: string;
  /** Body shown on lock screen — kept generic to avoid leaking content via APNs */
  body: string;
  /**
   * Free-form data the app uses to route on tap. Conventional keys:
   *   kind:    one of PushKind
   *   harness: harness slug to deep-link into
   *   card_id: operator card id (for kind='operator-suggestion')
   */
  data: Record<string, string> & { kind?: PushKind };
  /** Notification category for actions (intervention | smoke-fail) */
  category?: string;
}

interface DeviceTarget {
  platform: 'apns' | 'fcm';
  token: string;
}

export async function dispatchPush(
  targets: DeviceTarget[],
  payload: PushPayload,
): Promise<void> {
  await Promise.allSettled(
    targets.map((t) =>
      t.platform === 'apns' ? sendApns(t.token, payload) : sendFcm(t.token, payload),
    ),
  );
}

async function sendApns(deviceToken: string, payload: PushPayload): Promise<void> {
  const auth = process.env.APNS_AUTH_TOKEN; // pre-signed JWT, refreshed every hour
  const bundleId = process.env.APNS_BUNDLE_ID ?? 'com.papercuspai.operator.mobile';
  if (!auth) {
    console.warn('[push] APNS_AUTH_TOKEN not set; skipping APNs');
    return;
  }
  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      category: payload.category,
      'mutable-content': 1,
    },
    ...payload.data,
  });
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        method: 'POST',
        host: 'api.push.apple.com',
        port: 443,
        path: `/3/device/${deviceToken}`,
        headers: {
          'apns-topic': bundleId,
          'apns-push-type': 'alert',
          authorization: `bearer ${auth}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          res.statusCode && res.statusCode < 300 ? resolve() : reject(new Error(`apns ${res.statusCode}`)),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendFcm(deviceToken: string, payload: PushPayload): Promise<void> {
  const auth = process.env.FCM_OAUTH_TOKEN; // service-account access token, refreshed hourly
  const project = process.env.FCM_PROJECT_ID;
  if (!auth || !project) {
    console.warn('[push] FCM_OAUTH_TOKEN/FCM_PROJECT_ID not set; skipping FCM');
    return;
  }
  const body = JSON.stringify({
    message: {
      token: deviceToken,
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
      android: { priority: 'HIGH' },
    },
  });
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body,
  });
  if (!res.ok) console.warn(`[push] fcm ${res.status}: ${await res.text().catch(() => '')}`);
}

/** Convenience: load registered tokens for a workspace + dispatch a push. */
export async function notifyWorkspace(
  workspaceId: string,
  payload: PushPayload,
): Promise<void> {
  const { pushTargetsForWorkspace } = await import('./device-store');
  const targets = await pushTargetsForWorkspace(workspaceId);
  if (targets.length === 0) return;
  await dispatchPush(targets, payload);
}
