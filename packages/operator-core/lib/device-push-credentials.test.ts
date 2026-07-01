/**
 * device-push-credentials.test.ts — pins the JWT minting in the push-credential
 * refresher, a security-critical path: a wrong alg / wrong claims / bad base64url
 * / unverifiable signature here silently breaks APNs+FCM auth in production. We
 * generate real keys, mock fs+fetch, and ACTUALLY VERIFY each minted JWT's
 * signature against its public key — so the test fails if signing regresses, not
 * just if the string shape changes.
 *
 * Pinned: APNs ES256 header/claims + signature verifies; FCM RS256 assertion is
 * exchanged and the access token is surfaced; no-creds and missing-file paths
 * leave no token and never throw. Module-level env consts are captured at import,
 * so each test sets env then re-imports under vi.resetModules().
 *
 * In-tree (operator-core, tab-visible). fail-on-console: console is suppressed.
 * Run: cd packages/operator-core && npx vitest run lib/device-push-credentials.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';

// Real keys generated once — signing is deterministic given the key, so the
// verify assertions below are stable across runs.
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const APNS_PRIV_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FCM_PRIV_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const APNS_PATH = '/fake/AuthKey_ABCDE12345.p8';
const FCM_PATH = '/fake/service-account.json';
const SA_JSON = JSON.stringify({
  client_email: 'svc@proj.iam.gserviceaccount.com',
  private_key: FCM_PRIV_PEM,
  project_id: 'my-project',
  token_uri: 'https://oauth2.example/token',
});

// Mutable fs behaviour shared into the hoisted node:fs mock.
const h = vi.hoisted((): { exists: (p: string) => boolean; read: (p: string) => string } => ({
  exists: (_p: string) => true,
  read: (_p: string) => '',
}));
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: (p: string) => h.exists(p), readFileSync: (p: string) => h.read(p) };
});

const b64urlDecode = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

afterAll(() => vi.restoreAllMocks());

const ENV_KEYS = [
  'APNS_KEY_PATH', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_AUTH_TOKEN',
  'FCM_SERVICE_ACCOUNT_PATH', 'FCM_OAUTH_TOKEN', 'FCM_PROJECT_ID',
] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  // Installed per-test so these win over vitest-fail-on-console's own setup
  // hook (the refresher logs/warns on its normal paths; that noise is expected).
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  h.exists = () => true;
  h.read = () => '';
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('refreshAll — APNs (ES256)', () => {
  it('mints an ES256 JWT with the right claims and a signature that verifies', async () => {
    process.env.APNS_KEY_PATH = APNS_PATH;
    process.env.APNS_KEY_ID = 'ABCDE12345';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    h.read = () => APNS_PRIV_PEM;

    const mod = await import('./device-push-credentials');
    await mod.refreshAll();

    const jwt = process.env.APNS_AUTH_TOKEN;
    expect(jwt, 'APNS_AUTH_TOKEN should be set').toBeTruthy();
    const [head, payload, sig] = jwt!.split('.');
    expect([head, payload, sig].every(Boolean)).toBe(true);

    expect(b64urlDecode(head)).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'ABCDE12345' });
    const claims = b64urlDecode(payload);
    expect(claims.iss).toBe('TEAM123456');
    expect(claims.exp - claims.iat).toBe(3600); // 60-min TTL

    // The real proof: the signature validates against the public key (P1363/raw).
    const ok = createVerify('SHA256')
      .update(`${head}.${payload}`)
      .verify({ key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });

  it('does nothing when APNs is half-configured (missing key id)', async () => {
    process.env.APNS_KEY_PATH = APNS_PATH;
    process.env.APNS_TEAM_ID = 'TEAM123456';
    h.read = () => APNS_PRIV_PEM;
    const mod = await import('./device-push-credentials');
    await mod.refreshAll();
    expect(process.env.APNS_AUTH_TOKEN).toBeUndefined();
  });

  it('does nothing (no throw) when the key file is absent', async () => {
    process.env.APNS_KEY_PATH = APNS_PATH;
    process.env.APNS_KEY_ID = 'ABCDE12345';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    h.exists = () => false;
    const mod = await import('./device-push-credentials');
    await expect(mod.refreshAll()).resolves.toBeUndefined();
    expect(process.env.APNS_AUTH_TOKEN).toBeUndefined();
  });
});

describe('refreshAll — FCM v1 (RS256 → OAuth exchange)', () => {
  it('signs an RS256 assertion, exchanges it, and surfaces the access token', async () => {
    process.env.FCM_SERVICE_ACCOUNT_PATH = FCM_PATH;
    h.read = () => SA_JSON;

    let sentAssertion: string | null = null;
    let sentGrant: string | null = null;
    const fetchMock = vi.fn(async (_url: string, init: { body: URLSearchParams }) => {
      sentAssertion = init.body.get('assertion');
      sentGrant = init.body.get('grant_type');
      return { ok: true, json: async () => ({ access_token: 'ya29.fake', expires_in: 3600 }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./device-push-credentials');
    await mod.refreshAll();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentGrant).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(sentAssertion, 'assertion JWT should be sent').toBeTruthy();

    const [head, payload, sig] = sentAssertion!.split('.');
    expect(b64urlDecode(head)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = b64urlDecode(payload);
    expect(claims.iss).toBe('svc@proj.iam.gserviceaccount.com');
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(claims.aud).toBe('https://oauth2.example/token');
    const ok = createVerify('RSA-SHA256')
      .update(`${head}.${payload}`)
      .verify(rsa.publicKey, Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);

    expect(process.env.FCM_OAUTH_TOKEN).toBe('ya29.fake');
    expect(process.env.FCM_PROJECT_ID).toBe('my-project');
  });

  it('leaves no token when the OAuth exchange fails (non-ok response)', async () => {
    process.env.FCM_SERVICE_ACCOUNT_PATH = FCM_PATH;
    h.read = () => SA_JSON;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => 'denied' })));
    const mod = await import('./device-push-credentials');
    await mod.refreshAll();
    expect(process.env.FCM_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('refreshAll — no credentials configured', () => {
  it('sets no tokens and never throws', async () => {
    const mod = await import('./device-push-credentials');
    await expect(mod.refreshAll()).resolves.toBeUndefined();
    expect(process.env.APNS_AUTH_TOKEN).toBeUndefined();
    expect(process.env.FCM_OAUTH_TOKEN).toBeUndefined();
  });
});
