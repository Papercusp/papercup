import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildFcmMessage,
  resolveFcmCreds,
  pushEnabled,
  dispatchPush,
  isFcmTokenPermanentlyInvalid,
  tokensToReap,
  __resetPushCredsForTest,
} from './device-push-dispatcher';

const ENV_KEYS = [
  'FCM_SERVICE_ACCOUNT_PATH',
  'FCM_OAUTH_TOKEN',
  'FCM_PROJECT_ID',
  'APNS_AUTH_TOKEN',
  'APNS_KEY_PATH',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
];

let saved: Record<string, string | undefined>;
let dir: string;

function writeFakeServiceAccount(path: string, projectId = 'test-project') {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(
    path,
    JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key: privateKey,
      client_email: 'fbadmin@test-project.iam.gserviceaccount.com',
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  );
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __resetPushCredsForTest();
  // The dispatcher warns (once) when push is unconfigured/misconfigured — expected
  // in these tests; silence it so the repo's fail-on-console guard doesn't trip.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), 'push-test-'));
  // Point FCM at a nonexistent path so the real ~/.papercusp default never leaks in.
  process.env.FCM_SERVICE_ACCOUNT_PATH = join(dir, 'does-not-exist.json');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetPushCredsForTest();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('device-push-dispatcher', () => {
  it('buildFcmMessage produces the FCM v1 shape with HIGH android priority', () => {
    const msg = buildFcmMessage('device-token-123', {
      title: 'Needs you',
      body: 'A work item is waiting for approval',
      data: { kind: 'intervention', harness: 'papercusp' },
    });
    expect(msg.message.token).toBe('device-token-123');
    expect(msg.message.notification).toEqual({
      title: 'Needs you',
      body: 'A work item is waiting for approval',
    });
    expect(msg.message.data).toEqual({ kind: 'intervention', harness: 'papercusp' });
    expect(msg.message.android.priority).toBe('HIGH');
  });

  it('resolveFcmCreds returns null when the service account file is missing', () => {
    expect(resolveFcmCreds()).toBeNull();
  });

  it('resolveFcmCreds loads a valid service account and exposes projectId + token minter', () => {
    const path = join(dir, 'sa.json');
    writeFakeServiceAccount(path, 'papercusp-mobile');
    process.env.FCM_SERVICE_ACCOUNT_PATH = path;
    __resetPushCredsForTest();
    const creds = resolveFcmCreds();
    expect(creds).not.toBeNull();
    expect(creds!.projectId).toBe('papercusp-mobile');
    expect(typeof creds!.getAccessToken).toBe('function');
  });

  it('resolveFcmCreds returns null when the service account is missing required fields', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ project_id: 'x' })); // no client_email/private_key
    process.env.FCM_SERVICE_ACCOUNT_PATH = path;
    __resetPushCredsForTest();
    expect(resolveFcmCreds()).toBeNull();
  });

  it('pushEnabled reflects actual configuration', () => {
    // FCM unconfigured (bogus path), APNs unconfigured
    expect(pushEnabled()).toEqual({ fcm: false, apns: false });

    // APNs via an explicit pre-signed token
    process.env.APNS_AUTH_TOKEN = 'pre-signed-jwt';
    expect(pushEnabled().apns).toBe(true);
    delete process.env.APNS_AUTH_TOKEN;

    // APNs via key material trio
    process.env.APNS_KEY_PATH = '/tmp/AuthKey.p8';
    process.env.APNS_KEY_ID = 'ABC123';
    process.env.APNS_TEAM_ID = 'TEAM123';
    expect(pushEnabled().apns).toBe(true);

    // FCM configured
    const path = join(dir, 'sa.json');
    writeFakeServiceAccount(path);
    process.env.FCM_SERVICE_ACCOUNT_PATH = path;
    __resetPushCredsForTest();
    expect(pushEnabled().fcm).toBe(true);
  });

  it('dispatchPush cleanly SKIPS unconfigured providers (never throws)', async () => {
    const results = await dispatchPush(
      [
        { platform: 'fcm', token: 'fcm-tok' },
        { platform: 'apns', token: 'apns-tok' },
      ],
      { title: 't', body: 'b', data: { kind: 'smoke-fail' } },
    );
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.platform === 'fcm')).toMatchObject({ ok: false, status: 'skipped' });
    expect(results.find((r) => r.platform === 'apns')).toMatchObject({ ok: false, status: 'skipped' });
  });
});

/**
 * WI-37477 — reaping a token the provider says is permanently dead.
 *
 * The property under test is ASYMMETRIC: failing to reap costs a wasted push, reaping wrongly
 * DELETES a live device's only address. So every case below that is not the documented
 * UNREGISTERED contract is asserted NOT to reap — those are the controls, and they are the
 * point of the suite.
 */
describe('stale FCM token reaping (WI-37477)', () => {
  const UNREGISTERED_BODY = JSON.stringify({
    error: {
      code: 404,
      message: 'NotRegistered',
      status: 'NOT_FOUND',
      details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
    },
  });

  it('recognises the real production 404 body as permanently invalid', () => {
    expect(isFcmTokenPermanentlyInvalid(404, UNREGISTERED_BODY)).toBe(true);
  });

  it('recognises the legacy NotRegistered message without an errorCode block', () => {
    expect(isFcmTokenPermanentlyInvalid(404, '{"error":{"message":"NotRegistered"}}')).toBe(true);
  });

  // ── Controls: none of these may authorise a delete ──────────────────────────
  it('does NOT reap a transient failure, however it presents', () => {
    // A 5xx whose body happens to mention the word — status and error code must AGREE.
    expect(isFcmTokenPermanentlyInvalid(503, UNREGISTERED_BODY)).toBe(false);
    expect(isFcmTokenPermanentlyInvalid(500, 'internal error')).toBe(false);
    expect(isFcmTokenPermanentlyInvalid(401, 'auth expired')).toBe(false);
    // A 404 that is NOT the unregistered contract (e.g. a wrong project id in the URL).
    expect(isFcmTokenPermanentlyInvalid(404, '{"error":{"message":"Requested entity was not found."}}')).toBe(false);
    expect(isFcmTokenPermanentlyInvalid(404, '')).toBe(false);
    // An unconfigured provider is the single most common `ok:false` on this box today.
    expect(isFcmTokenPermanentlyInvalid('skipped', UNREGISTERED_BODY)).toBe(false);
    expect(isFcmTokenPermanentlyInvalid('error', UNREGISTERED_BODY)).toBe(false);
  });

  it('tokensToReap selects only the unregistered targets, by index', () => {
    const targets = [
      { platform: 'fcm' as const, token: 'live' },
      { platform: 'fcm' as const, token: 'dead' },
      { platform: 'apns' as const, token: 'transient' },
    ];
    const results = [
      { platform: 'fcm' as const, ok: true, status: 200 },
      { platform: 'fcm' as const, ok: false, status: 404, unregistered: true },
      { platform: 'apns' as const, ok: false, status: 503 },
    ];
    expect(tokensToReap(targets, results).map((t) => t.token)).toEqual(['dead']);
  });

  it('tokensToReap fails CLOSED when the arrays disagree in length', () => {
    // A shifted index would delete the WRONG live device's token — strictly worse than
    // leaving a dead one registered, so a broken correspondence must reap nothing.
    const targets = [
      { platform: 'fcm' as const, token: 'a' },
      { platform: 'fcm' as const, token: 'b' },
    ];
    expect(tokensToReap(targets, [{ platform: 'fcm', ok: false, status: 404, unregistered: true }])).toEqual([]);
  });

  it('notifyWorkspace DELETES an unregistered token and leaves the healthy ones alone', async () => {
    const deleted: string[] = [];
    vi.doMock('./device-store', () => ({
      pushTargetsForWorkspace: async () => [
        { platform: 'fcm', token: 'live-token' },
        { platform: 'fcm', token: 'dead-token' },
      ],
      deletePushToken: async (_ws: string, token: string) => {
        deleted.push(token);
      },
    }));
    vi.resetModules();
    const mod = await import('./device-push-dispatcher');
    const results = await mod.notifyWorkspace(
      'papercusp-workspace',
      { title: 't', body: 'b', data: { kind: 'intervention' } },
      {
        dispatch: async (targets) =>
          targets.map((t) =>
            t.token === 'dead-token'
              ? { platform: 'fcm' as const, ok: false, status: 404, unregistered: true }
              : { platform: 'fcm' as const, ok: true, status: 200 },
          ),
      },
    );
    expect(results).toHaveLength(2);
    expect(deleted).toEqual(['dead-token']);
    vi.doUnmock('./device-store');
    vi.resetModules();
  });
});
