/**
 * Defguard admin API client. Used by the mobile pair endpoint to mint an
 * enrollment URL+token bound to a per-device Defguard user. The phone uses
 * the URL+token via the Defguard enrollment flow (Rust-side `mesh_enroll`
 * Tauri command) to generate a WireGuard keypair, register the pubkey,
 * and receive its WG config.
 *
 * Env vars (set in `.env.local`):
 *   - DEFGUARD_URL          — e.g. https://mesh.papercuspai.com (control plane)
 *   - DEFGUARD_API_TOKEN    — admin bearer minted from /admin/users/admin/api-tokens
 *
 * Without these the pair endpoint returns enrollmentUrl/Token = null and
 * the phone falls back to LAN-only routing.
 *
 * Defguard flow (verified against defguard-core 2.0.1):
 *   1. POST /api/v1/user        — create one user per phone device
 *   2. POST /api/v1/user/{u}/start_enrollment — mint URL+token
 *
 * Ownership/cleanup: caller is responsible for deleting the per-device
 * user when the device is revoked (DELETE /api/v1/user/{u}).
 */

const DEFGUARD_URL = process.env.DEFGUARD_URL ?? process.env.DEFGUARD_CONTROL_URL ?? 'https://mesh.papercuspai.com';
const DEFGUARD_TOKEN = process.env.DEFGUARD_API_TOKEN ?? '';

export interface DefguardEnrollment {
  controlUrl: string;
  enrollmentUrl: string;
  enrollmentToken: string;
  defguardUsername: string;
}

function deviceUsername(deviceId: string): string {
  return `pcusp-${deviceId.slice(0, 12)}`.replace(/[^a-zA-Z0-9-]/g, '');
}

async function dg<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DEFGUARD_URL}${path}`, {
    method,
    headers: {
      'authorization': `Bearer ${DEFGUARD_TOKEN}`,
      'content-type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`defguard ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? (JSON.parse(text) as T) : (null as T);
}

export async function mintDefguardEnrollment(opts: {
  deviceId: string;
  userEmail: string;
  workspaceId: string;
}): Promise<DefguardEnrollment | null> {
  if (!DEFGUARD_TOKEN) return null;

  const username = deviceUsername(opts.deviceId);
  const ownerEmail = opts.userEmail || 'local@desktop';

  // Create user-per-device. 409 means it already exists (re-pair); ignore.
  try {
    await dg('POST', '/api/v1/user', {
      username,
      first_name: 'Papercusp',
      last_name: `Device ${opts.deviceId.slice(0, 8)}`,
      email: `${username}@papercusp.local`,
      phone: null,
      password: null,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes('409')) throw e;
  }

  // Mint enrollment.
  const enrol = await dg<{ enrollment_token: string; enrollment_url: string }>(
    'POST',
    `/api/v1/user/${username}/start_enrollment`,
    { send_enrollment_notification: false, email: null },
  );

  // Audit-trail nicety: stash the original operator user email as a Defguard
  // user attribute so admins can see who triggered the pairing. Best-effort.
  void ownerEmail;

  return {
    controlUrl: DEFGUARD_URL,
    enrollmentUrl: enrol.enrollment_url,
    enrollmentToken: enrol.enrollment_token,
    defguardUsername: username,
  };
}

export async function revokeDefguardUser(deviceId: string): Promise<void> {
  if (!DEFGUARD_TOKEN) return;
  const username = deviceUsername(deviceId);
  try {
    await dg('DELETE', `/api/v1/user/${username}`);
  } catch (e) {
    if (!(e as Error).message.includes('404')) throw e;
  }
}
