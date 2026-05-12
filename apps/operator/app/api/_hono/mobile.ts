/**
 * Mobile API routes — pair, push registration, voice WS bootstrap, workspaces.
 *
 * Auth model:
 *   - POST /pair: unauthenticated; consumes a one-time pair_token (minted by
 *     desktop UI when user clicks "Pair new device")
 *   - All other routes require Authorization: Bearer <deviceToken> JWT
 *
 * Voice WS (/voice) is exposed as a route here for token validation, but the
 * actual upgrade is handled by the existing pty/WS infra — see WS_NOTE below.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { join } from 'node:path';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { resolvePhasedProject, harnessDir } from './harness';
import { phasePhaseLabel } from '@/lib/harness-phases';
import {
  signDeviceToken,
  verifyDeviceToken,
  deviceAuth,
  type DeviceClaims,
} from '../../../lib/mobile-jwt';
import { subscribe, backfillSince, type SyncEvent } from '../../../lib/sync-sse';
import { getMobileVoicePort } from '../../../lib/mobile-voice-ws';
import { claimVoiceLease, releaseVoiceLease, readVoiceLease } from '../../../lib/voice-lease';
import { mintDefguardEnrollment } from '../../../lib/defguard-client';
import {
  mintPairToken,
  consumePairToken,
  newDeviceId,
} from '../../../lib/mobile-pair-store';
import { readRegistry, workspaceById, activeWorkspaceId } from '../../../lib/workspace-registry';
import { ensureMobileDevicesTable } from '../../../lib/ensure-schema';
import {
  insertDevice,
  listDevices,
  revokeDevice,
  touchLastSeen,
  upsertPushToken,
  isRevoked,
} from '../../../lib/mobile-device-store';
import {
  listPendingCards,
  dispatchCard,
  dismissCard,
  setPaused,
  setResumed,
  getPauseInfo,
} from '../../../lib/mobile-operator-actions';
import { recentToasts, recentAuditEntries, currentlyRunning, lastActivityAt } from '../../../lib/mobile-feeds';
import { listHarnessesFor, harnessStatusFor, harnessExistsInWorkspace } from '../../../lib/mobile-harnesses';
import { readCandidates, refreshCandidates } from '../../../lib/operator-standing-candidates';
import { appendPreferenceEntry } from '../../../lib/operator-preferences';

const app = new Hono<{ Variables: { deviceClaims: DeviceClaims } }>();

// CORS — the Tauri WebView's origin is `http://tauri.localhost` (or
// `https://tauri.localhost` with --release), browser-dev tabs hit
// `http://localhost:1420`. Both need to talk to /api/mobile/*. The desktop
// Hono mount is on the same origin so doesn't need this; mobile clients
// are always cross-origin.
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin;
    if (origin.endsWith('://tauri.localhost')) return origin;
    if (origin.startsWith('http://localhost:')) return origin;
    if (origin.startsWith('http://127.0.0.1:')) return origin;
    if (origin.startsWith('http://10.0.2.2:')) return origin;
    return '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['authorization', 'content-type', 'last-event-id'],
  credentials: true,
  maxAge: 600,
}));

// Ensure DDL on first request to /api/mobile/* — keeps the convention used by
// other routers (lazy + idempotent + globalThis-pinned cache).
app.use('*', async (_c, next) => {
  await ensureMobileDevicesTable().catch(() => { /* logged elsewhere */ });
  await next();
});

// ── Desktop-side routes (loopback-only, no session cookie) ──────────────
// Used by the operator's settings UI. Gated on the request Host header
// resolving to a loopback name. Pairing is launched from the desktop's own
// browser/Tauri webview, which always sees Host=localhost (or 127.0.0.1 /
// ::1). Rejecting any other Host means a LAN peer hitting the operator's
// LAN-bound port (operator binds 0.0.0.0) cannot mint a pair token.
//
// Limitation: Host is a client-supplied header and trivially spoofable by a
// determined LAN attacker (`curl -H "Host: localhost"`). Real exposure
// (Defguard mesh, tunnel) needs an additional layer — either bind operator
// to 127.0.0.1 only, or front mint-pair-token with a real auth check.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const desktopAuth = async (c: any, next: any) => {
  const host = (c.req.header('host') ?? '').split(':')[0].toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    return c.json({ error: 'loopback_only' }, 403);
  }
  c.set('sessionUser', { email: 'local@desktop' });
  await next();
};

app.use('/desktop/*', desktopAuth);



/**
 * First non-internal RFC1918 IPv4 on this host. Used so the QR encodes
 * a LAN address the phone can route to (vs. `localhost`, which on the
 * phone resolves to the phone itself).
 */
function lanAddress(): string | null {
  const ifaces = require('node:os').networkInterfaces() as Record<string, Array<{ address: string; family: string; internal: boolean }> | undefined>;
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const i of list) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) return i.address;
    }
  }
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const i of list) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

app.post('/desktop/mint-pair-token', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { workspaceId } = z
    .object({ workspaceId: z.string().min(1) })
    .parse(body);
  if (!workspaceById(workspaceId)) {
    return c.json({ error: 'workspace_not_found' }, 400);
  }
  const sessionUser = c.get('sessionUser') as { email: string };

  // Phone needs to reach the desktop. Override hierarchy:
  //   1. MOBILE_DESKTOP_PUBLIC_URL env (full URL, e.g. https://api.papercupai.com)
  //      — used when the phone may not be on the same LAN at first-pair time.
  //   2. MOBILE_DESKTOP_HOST env (host:port, e.g. mesh DNS)
  //   3. Detected LAN IP + the port from the incoming request
  //   4. Fall back to request Host (works for desktop-local browser only)
  const reqHost = c.req.header('host') ?? 'localhost:3055';
  const port = reqHost.includes(':') ? reqHost.split(':')[1] : '3055';
  const lan = lanAddress();
  const publicUrl = process.env.MOBILE_DESKTOP_PUBLIC_URL;
  const desktopHost = publicUrl
    ? publicUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
    : (process.env.MOBILE_DESKTOP_HOST ?? (lan ? `${lan}:${port}` : reqHost));
  const serverUrl = publicUrl
    ? publicUrl.replace(/\/$/, '')
    : `http://${desktopHost}`;

  const { pairToken, expiresAt } = await mintPairToken({
    workspaceId,
    desktopHost,
    userEmail: sessionUser.email,
  });
  return c.json({
    qrPayload: {
      server: serverUrl,
      pairToken,
      workspaceId,
    },
    expiresAt,
  });
});

// ── Phone-side: redeem pair token for a long-lived device JWT ───────────

// ── REST query endpoint for libs/sync polling fetcher ──────────────────
//
// libs/sync's polling adapter (and SSE adapter, which uses it as the data
// fetcher under push invalidations) calls `${restEndpoint}/rest-query?name=
// <queryName>&args=<json>`. Mobile screens migrating to libs/sync route
// through here. Same `?token=<jwt>` auth pattern as the SSE handshake —
// EventSource-style, since libs/sync's polling fetcher uses bare `fetch()`
// without headers.
//
// Returns `{rows, version}` matching the desktop `/api/zero-harness/rest-
// query` shape that libs/sync expects.
//
// This endpoint is registered BEFORE `deviceAuth()` for the same reason as
// /sync/sse — auth is via the `?token=` query param, not Authorization
// header.
app.get('/rest-query', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'token_required' }, 401);
  const claims = verifyDeviceToken(token);
  if (!claims) return c.json({ error: 'invalid_token' }, 401);

  const name = c.req.query('name');
  if (!name) return c.json({ error: 'missing name' }, 400);
  const argsJson = c.req.query('args') ?? '{}';
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return c.json({ error: 'invalid args (not JSON)' }, 400);
  }

  // Dispatch by query name. Each case maps to existing handler logic; the
  // handler is responsible for honoring claims.workspace_id via withWorkspace
  // (which all the mobile-feeds / mobile-harnesses helpers already do).
  try {
    switch (name) {
      case 'toastLog.recent': {
        const limit = Math.min(Number(args.limit) || 50, 200);
        const rows = await recentToasts(claims.workspace_id, limit);
        return c.json({ rows, version: String(Date.now()) });
      }
      case 'auditLog.recent': {
        const limit = Math.min(Number(args.limit) || 50, 200);
        const rows = await recentAuditEntries(claims.workspace_id, limit);
        return c.json({ rows, version: String(Date.now()) });
      }
      case 'operatorScans.running': {
        const snap = await currentlyRunning(claims.workspace_id);
        // The polling fetcher expects {rows: T[]}. For single-value queries
        // we wrap in a one-element array; the screen's hook unwraps via
        // `data[0]` (or migrates to a useSyncQuery<T>() variant if libs/sync
        // grows one).
        return c.json({ rows: [snap], version: String(Date.now()) });
      }
      case 'harnessStatus.list': {
        const rows = await listHarnessesFor(claims.workspace_id);
        return c.json({ rows, version: String(Date.now()) });
      }
      case 'harnessStatus.byHarness': {
        const slug = String(args.harnessSlug ?? '');
        if (!slug) return c.json({ error: 'missing harnessSlug' }, 400);
        const status = await harnessStatusFor(claims.workspace_id, slug);
        return c.json({ rows: status ? [status] : [], version: String(Date.now()) });
      }
      case 'standingCandidates.list': {
        const candidates = await refreshCandidates().catch(() => readCandidates());
        return c.json({ rows: candidates, version: String(Date.now()) });
      }
      default:
        return c.json({ error: `unknown query: ${name}` }, 400);
    }
  } catch (e) {
    console.error('[/rest-query]', name, e);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
// ── Phone-side: redeem pair token for a long-lived device JWT ───────────
// Unauthenticated; consumes a one-time pair_token minted by the desktop UI.
// MUST stay above the deviceAuth() middleware below.
app.post('/pair', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ pairToken: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const pending = await consumePairToken(parsed.data.pairToken);
  if (!pending) return c.json({ error: 'invalid_or_expired_token' }, 401);

  const deviceId = newDeviceId();
  const deviceToken = signDeviceToken({
    sub: deviceId,
    workspace_id: pending.workspaceId,
    device_kind: 'mobile',
    user_email: pending.userEmail,
  });

  await insertDevice({
    deviceId,
    userEmail: pending.userEmail ?? 'unknown@local',
    workspaceId: pending.workspaceId,
  });

  // TODO: mint a Defguard enrollment token via Defguard's gRPC/REST API
  //       and return it; phone uses it to join the mesh. For v1 we let
  //       the user complete Defguard enrollment manually via its own URL.
  const defguardEnrollmentUrl =
    process.env.DEFGUARD_ENROLLMENT_URL ?? 'https://mesh.papercuspai.com/enroll';

  return c.json({
    deviceToken,
    deviceId,
    desktopHost: pending.desktopHost,
    workspaceId: pending.workspaceId,
    defguardEnrollmentUrl,
  });
});

// ── Anything below requires bearer token ────────────────────────────────
app.use('/*', deviceAuth());

// Workspaces visible to this device.
//
// Workspace memberships in Papercusp are not a multi-user ACL — the registry at
// ~/.papercusp-workspaces/registry.json is the desktop user's local list of
// workspaces. A paired phone gets to see all of them (paired = the desktop
// user is implicitly the same user). If multi-user / cross-machine workspace
// membership lands later, gate this endpoint on it.

// Switch active workspace; re-issues the device token with new claim.
app.post('/workspace/switch', async (c) => {
  const claims = c.get('deviceClaims');
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ workspaceId: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  // Access check: workspace must exist in the local registry. This prevents a
  // device token from claiming a workspace that doesn't exist on this machine
  // (which would either RLS-deny everything or, worse, land in '' bucket).
  if (!workspaceById(parsed.data.workspaceId)) {
    return c.json({ error: 'workspace_not_found' }, 403);
  }

  const deviceToken = signDeviceToken({
    sub: claims.sub,
    workspace_id: parsed.data.workspaceId,
    device_kind: 'mobile',
    user_email: claims.user_email,
  });
  return c.json({ deviceToken, workspaceId: parsed.data.workspaceId });
});

// Paired devices list (for desktop UI's "Manage paired devices" panel).
//
// NOTE: this endpoint sits behind deviceAuth() and is therefore reachable only
// by paired phones. The desktop settings page calls this without a JWT — for
// that case we expose `/api/mobile/desktop/devices` below using session auth.
app.get('/devices', async (c) => {
  const claims = c.get('deviceClaims');
  const rows = await listDevices(claims.workspace_id);
  return c.json({
    devices: rows.map((d) => ({
      device_id: d.device_id,
      device_label: d.device_label,
      paired_at: d.paired_at,
      last_seen: d.last_seen,
      workspace_id: d.workspace_id,
    })),
  });
});

app.delete('/devices/:deviceId', async (c) => {
  const claims = c.get('deviceClaims');
  await revokeDevice(c.req.param('deviceId'), claims.workspace_id);
  return c.json({ ok: true });
});

// Touch last_seen so the desktop UI shows "active 3m ago".

// Push token registration (APNs / FCM).

// Runtime config the phone needs after pairing.
app.get('/runtime-config', async (c) => {
  const claims = c.get('deviceClaims');
  // Mesh hostname Defguard assigns. Phone uses this as the base for the
  // mobile SSE endpoint (`/api/mobile/sync/sse?token=...`) once it
  // migrates off polling.
  const meshHost =
    process.env.MOBILE_MESH_HOST ??
    process.env.MOBILE_DESKTOP_HOST ??
    'localhost:3055';
  return c.json({
    meshHost,
    workspaceId: claims.workspace_id,
    deviceKind: 'mobile' as const,
    voiceWs: {
      // null when the voice WS failed to bind any port — phone shows
      // "voice unavailable" instead of silently failing to connect.
      port: getMobileVoicePort(),
      path: '/api/mobile/voice',
    },
  });
});

// ── Backfill of /api/mobile routes mobile clients hit but Hono didn't
// have. Added 2026-05-11 by mobile agent to unblock testing while
// backend agent ports the same shape into their roadmap. Wire shapes
// mirror papercup-rust-server/openapi.yaml. All gated by deviceAuth.

app.get('/workspaces', async (c) => {
  const claims = c.get('deviceClaims');
  const reg = readRegistry();
  // Field name `name` matches the openapi.yaml WorkspaceItem shape the
  // Rust mobile client decodes; emitting `label` made the iOS Settings
  // tab fail with ApiError::Decode.
  return c.json({
    workspaces: reg.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      current: w.id === claims.workspace_id,
    })),
  });
});

// Note: paired-devices live at the pre-existing GET /devices and
// DELETE /devices/:deviceId (above the runtime-config block). The
// Rust client was updated to hit those rather than /desktop/devices,
// which is pre-empted by the desktopAuth middleware at line 110.

// Voice lease — only one device listens at a time. Phone pre-empts.
app.get('/voice-lease', async (c) => {
  const claims = c.get('deviceClaims');
  const lease = await readVoiceLease(claims.workspace_id);
  return c.json({ lease });
});

app.post('/voice-lease/claim', async (c) => {
  const claims = c.get('deviceClaims');
  await claimVoiceLease({
    workspaceId: claims.workspace_id,
    ownerKind: 'mobile',
    ownerId: claims.sub,
  });
  return c.json({ ok: true });
});

app.post('/voice-lease/heartbeat', async (c) => {
  const claims = c.get('deviceClaims');
  await claimVoiceLease({
    workspaceId: claims.workspace_id,
    ownerKind: 'mobile',
    ownerId: claims.sub,
  });
  return c.json({ ok: true });
});

app.delete('/voice-lease', async (c) => {
  const claims = c.get('deviceClaims');
  await releaseVoiceLease({
    workspaceId: claims.workspace_id,
    ownerId: claims.sub,
  });
  return c.json({ ok: true });
});

// Activity tab feeds.
app.get('/notifications/recent', async (c) => {
  const claims = c.get('deviceClaims');
  const limit = Math.min(Number(c.req.query('limit') ?? '50') || 50, 200);
  const rows = await recentToasts(claims.workspace_id, limit);
  return c.json({ toasts: rows });
});

app.get('/actions/recent', async (c) => {
  const claims = c.get('deviceClaims');
  const limit = Math.min(Number(c.req.query('limit') ?? '50') || 50, 200);
  const rows = await recentAuditEntries(claims.workspace_id, limit);
  return c.json({ entries: rows });
});

// Global pause flag — get / set / clear.
app.get('/operator/pause', async (_c) => {
  return _c.json(await getPauseInfo());
});

app.post('/operator/pause', async (c) => {
  const claims = c.get('deviceClaims');
  await setPaused(claims.user_email ?? 'mobile');
  return c.json(await getPauseInfo());
});

app.delete('/operator/pause', async (c) => {
  await setResumed();
  return c.json(await getPauseInfo());
});

// Heartbeat — bumps last_seen so the desktop "active 3m ago" badge stays green.
app.post('/heartbeat', async (c) => {
  const claims = c.get('deviceClaims');
  await touchLastSeen(claims.sub, claims.workspace_id);
  return c.json({ ok: true });
});

// Phone-side EL voice tools that DON'T touch the phone's UI run as a
// server-side proxy via this endpoint. The Rust mobile client's
// VoiceManager dispatcher falls through to here for any tool name it
// doesn't natively handle (~30 of the 37 tools the EL agent has
// configured — harness_status, harness_list, ask_operator, etc.).
//
// EL normalizes registry ids ('harness.status') to underscore form
// ('harness_status'). We reverse the normalization to look up the def.
// Tools that ARE browser:'required' AND map to phone UI are still
// handled client-side on the phone (they're the navigation set).
//
// Body: { parameters: {...EL tool params} }
// Returns: { ok: true, value: <json> } or { ok: false, error: {...} }
app.post('/voice-tool/:name', async (c) => {
  const claims = c.get('deviceClaims');
  const elName = c.req.param('name');
  if (!elName) return c.json({ error: 'missing tool name' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const params = (body && typeof body === 'object' && 'parameters' in body)
    ? (body as { parameters?: unknown }).parameters ?? {}
    : body ?? {};

  // EL normalizes registry ids by replacing dots+dashes with underscores
  // (e.g. 'harness.list-features' → 'harness_list_features'). The reverse
  // isn't unique, so we iterate the registry and match by normalized form.
  // Side-effect import populates the registry — without this the route
  // sees an empty registry because mobile.ts itself doesn't pull defs.
  await import('../../../lib/commands/defs');
  const { get, list, runCommand, runQuery } = await import('../../../lib/commands/registry');
  let def: ReturnType<typeof get> | undefined;
  let resolvedId: string | undefined;
  // Fast paths: literal + underscore-to-dot (covers most cases).
  for (const candidate of [elName, elName.replace(/_/g, '.')]) {
    const d = get(candidate);
    if (d) { def = d; resolvedId = candidate; break; }
  }
  // Fallback: search all registered defs by normalized form.
  if (!def) {
    const all = [
      ...list({ kind: 'command', agent: 'operator' }),
      ...list({ kind: 'query', agent: 'operator' }),
    ];
    for (const d of all) {
      if (d.id.replace(/[.-]/g, '_') === elName) {
        def = d; resolvedId = d.id; break;
      }
    }
  }
  if (!def || !resolvedId) {
    return c.json({ ok: false, error: { code: 'unknown-tool', message: `no such registry tool: ${elName}`, retryable: false } }, 404);
  }
  const { randomUUID } = await import('node:crypto');
  const ctx = {
    agent: 'operator' as const,
    workspace: claims.workspace_id,
    sessionId: claims.sub,
    requestId: `el-mobile-${randomUUID()}`,
    surface: ((): 'mobile-android' | 'mobile-ios' | 'mobile-unknown' => {
      const ua = c.req.header('user-agent') ?? '';
      return ua.includes('Android') ? 'mobile-android'
        : ua.includes('Darwin') || ua.includes('iPhone') ? 'mobile-ios'
        : 'mobile-unknown';
    })(),
    deviceId: claims.sub,
  };
  try {
    const result = def.kind === 'query'
      ? await runQuery(resolvedId, params, ctx)
      : await runCommand(resolvedId, params, ctx);
    return c.json(result);
  } catch (e) {
    return c.json({ ok: false, error: { code: 'tool-exec', message: (e as Error)?.message ?? String(e), retryable: true } }, 500);
  }
});

// Mints a short-lived ElevenLabs Conv AI conversation token for this
// device. Mirrors /api/agent-mcp/operator-elevenlabs-bootstrap for desktop
// but adds the phone-specific dynamic variables the agent needs to route
// browser:'required' callbacks back to the right device.
//
// Returns:
//   { conversationToken, agentId, dynamicVariables: {device_id, workspace_id, surface} }
//
// Phone uses the ElevenLabs Android/iOS SDK to start a WebRTC session
// with this token + dynamicVariables. ElevenLabs holds the agent prompt;
// it's the same agent the desktop uses. See docs/VOICE_V1_PLAN.md.
//
// Mint protection mirrors the desktop's operator-elevenlabs-bootstrap:
//   - 8s cooldown (per-agentId, PG-backed via cooldown_marks) so a
//     network-hiccup pair retry doesn't spam EL.
//   - In-flight dedupe (process-local Map) so parallel mobile clients
//     paired to the same desktop share one mint round-trip.
//   - Concurrent-limit error mapping (EL 429 → 503 with hint) so the
//     mobile client can show "another tab still has voice".
//
// Token mints don't bill directly, but each consumes the workspace
// concurrency slot for ~30s — spam-pair without protection would DoS
// the user's own voice sessions. EL credit-burn audit, fix #4.
const MOBILE_MINT_COOLDOWN_MS = 8_000;
const mobileMintInFlight = new Map<
  string,
  Promise<{ token: string } | { error: string; status: number; detail: string }>
>();

async function mintMobileElToken(
  agentId: string,
  apiKey: string,
  elSource: string,
): Promise<{ token: string } | { error: string; status: number; detail: string }> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}&source=${elSource}`,
      {
        method: 'GET',
        headers: { 'xi-api-key': apiKey, 'accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      },
    );
  } catch (err) {
    return { error: 'mint_failed', status: 502, detail: (err as Error)?.message ?? String(err) };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    if (res.status === 429 && /concurrent_limit_exceeded|workspace_concurrency_limit/i.test(detail)) {
      return { error: 'concurrent_limit', status: res.status, detail };
    }
    return { error: 'mint_rejected', status: res.status, detail };
  }
  const raw = await res.text();
  let parsed: { token?: string; conversation_token?: string } = {};
  try { parsed = JSON.parse(raw); } catch { /* keep empty */ }
  const token = parsed.token ?? parsed.conversation_token;
  if (typeof token !== 'string' || !token) {
    return { error: 'mint_shape', status: 502, detail: `no token in EL response; raw: ${raw.slice(0, 200)}` };
  }
  return { token };
}

app.get('/voice-session-init', async (c) => {
  const claims = c.get('deviceClaims');
  // Reuse the desktop's voice prefs + EL credentials. Same agent, no
  // mobile-only agent_id.
  const { loadVoicePrefs } = await import('../../../lib/voice-prefs');
  const { readElevenLabsKey } = await import('../../../lib/voice-credentials');
  const { readCooldownMark, writeCooldownMark } = await import('../../../lib/cooldown-marks');
  const prefs = await loadVoicePrefs();
  if (prefs.fullAgentEngine !== 'elevenlabs-conv' &&
      prefs.fullAgentEngine !== 'elevenlabs-conversational') {
    return c.json({ error: 'voice_not_enabled', hint: 'Set fullAgentEngine to elevenlabs-conv in /settings/voice.' }, 404);
  }
  const agentId = prefs.elevenLabsAgentId?.trim();
  if (!agentId) {
    return c.json({ error: 'no_agent_id', hint: 'Set elevenLabsAgentId in /settings/voice.' }, 404);
  }
  const apiKey = await readElevenLabsKey();
  if (!apiKey) {
    return c.json({ error: 'no_api_key', hint: 'Add ElevenLabs API key in /settings/api-keys.' }, 404);
  }

  // Cooldown gate — refuse if a mint for this agent fired in the last 8s.
  // Shared with the desktop via harness_shared.cooldown_marks, so a
  // mobile retry that races a desktop mint also waits.
  const cooldownKey = `el-mint:${agentId}`;
  const lastMintMs = (await readCooldownMark(cooldownKey)) ?? 0;
  const sinceLast = Date.now() - lastMintMs;
  if (sinceLast < MOBILE_MINT_COOLDOWN_MS) {
    const retryInMs = MOBILE_MINT_COOLDOWN_MS - sinceLast;
    return c.json(
      {
        error: 'mint_cooldown',
        hint: `Slow down — minted a fresh EL token ${(sinceLast / 1000).toFixed(1)}s ago. Retry in ${(retryInMs / 1000).toFixed(1)}s.`,
        retryAfterMs: retryInMs,
      },
      429,
      { 'Retry-After': String(Math.ceil(retryInMs / 1000)) },
    );
  }

  // Detect platform up front — we need to pass an allowed `source` to EL
  // (their API rejects arbitrary strings). Their enum has android_sdk +
  // swift_sdk; default unknown.
  const ua = c.req.header('user-agent') ?? '';
  let surface = c.req.query('surface');
  if (!surface) {
    surface = ua.includes('Android') ? 'mobile-android'
            : ua.includes('Darwin') || ua.includes('iPhone') ? 'mobile-ios'
            : 'mobile-unknown';
  }
  const elSource = surface === 'mobile-android' ? 'android_sdk'
                 : surface === 'mobile-ios' ? 'swift_sdk'
                 : 'unknown';

  // In-flight dedupe: parallel pair-retries on the same agentId share
  // one outstanding mint promise. Keyed by agentId so concurrent
  // mobile clients targeting the same desktop reuse the same fetch.
  let pending = mobileMintInFlight.get(agentId);
  if (!pending) {
    pending = mintMobileElToken(agentId, apiKey, elSource).finally(() => {
      mobileMintInFlight.delete(agentId);
    });
    mobileMintInFlight.set(agentId, pending);
  }
  const result = await pending;

  if ('error' in result) {
    if (result.error === 'concurrent_limit') {
      return c.json(
        {
          error: 'concurrent_limit',
          hint: 'Another tab or device still has an active EL session. Close other operator sessions and retry. (EL Conv AI workspace concurrency limit.)',
          status: result.status,
          detail: result.detail,
        },
        503,
      );
    }
    return c.json(
      { error: result.error, detail: result.detail },
      result.status === 429 ? 503 : 502,
    );
  }

  // Successful mint — record so subsequent calls (mobile or desktop)
  // are throttled.
  await writeCooldownMark(cooldownKey);

  return c.json({
    conversationToken: result.token,
    agentId,
    dynamicVariables: {
      device_id: claims.sub,
      workspace_id: claims.workspace_id,
      surface,
      desktop_host: process.env.MOBILE_DESKTOP_HOST ?? '',
    },
  });
});

// ── Operator panel surface for mobile ──────────────────────────────────
//
// Mobile reads operator-suggestions over plain HTTP (vs Zero) because
// `harness_shared.operator_scans` isn't in the zero_harness publication.
// Adding it would mean schema work + publication update + permission rev;
// for v1 we poll. The desktop OperatorPanel uses the same path.

app.get('/operator/cards', async (_c) => {
  const cards = await listPendingCards();
  return _c.json({ cards });
});

app.post('/operator/cards/:id/dispatch', async (c) => {
  const id = c.req.param('id');
  const cards = await listPendingCards();
  const card = cards.find((x) => x.id === id);
  if (!card) return c.json({ ok: false, error: 'card_not_found' }, 404);
  const result = await dispatchCard(card);
  return c.json({ ok: true, message: result });
});

// Pause / resume sentinel — mobile mirrors of /api/agent-mcp/operator-pause-flag
// but gated on deviceAuth (the desktop one needs a session cookie).



// Standing-approval candidates — surfaces the same candidates the desktop's
// /api/agent-mcp/operator-standing-approvals returns. Phone shows them so a
// user can approve/dismiss with a tap, equivalent to the voice flow.
app.get('/operator/standing-candidates', async (_c) => {
  const candidates = await refreshCandidates().catch(() => readCandidates());
  return _c.json({ candidates });
});

app.post('/operator/standing-candidates/decide', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    capability: z.string().min(1),
    targetHarness: z.string().min(1),
    decision: z.enum(['approve', 'dismiss']),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  if (parsed.data.decision === 'approve') {
    const today = new Date().toISOString().slice(0, 10);
    const entry = `- [OPERATOR-PROPOSED-USER-CONFIRMED-${today}] [STANDING-APPROVE]\n  capability=${parsed.data.capability}, target=${parsed.data.targetHarness}\n  pattern: ≥3 silent dispatches in 24h\n  user confirmed: ${new Date().toISOString()}`;
    await appendPreferenceEntry(entry);
  }
  await refreshCandidates().catch(() => {});
  return c.json({ ok: true });
});

app.post('/operator/cards/:id/dismiss', async (c) => {
  const id = c.req.param('id');
  const cards = await listPendingCards();
  const card = cards.find((x) => x.id === id);
  if (!card) return c.json({ ok: false, error: 'card_not_found' }, 404);
  const result = await dismissCard(card);
  return c.json({ ok: true, message: result });
});

// Notifications / recent toasts (workspace-scoped via JWT claim).


/**
 * Mobile-shim mutators. Verify the slug exists in the phone's workspace
 * before proxying to the desktop's existing endpoint. Action runs against
 * the *desktop's* active workspace; matching workspace_id between phone
 * claim and desktop active is required for the desktop endpoint to find
 * the slug. Mismatch surfaces as a 404 from the proxied call, which we
 * pass through.
 */
async function shimHarnessAction(
  c: any,
  path: string,
  method: 'POST' = 'POST',
  body: unknown = {},
) {
  const claims = c.get('deviceClaims');
  const slug = c.req.param('slug');
  if (!(await harnessExistsInWorkspace(claims.workspace_id, slug))) {
    return c.json({ error: 'harness_not_in_workspace' }, 404);
  }
  const base = process.env.MOBILE_SELF_BASE ?? `http://localhost:${process.env.PORT ?? 3055}`;
  const res = await fetch(`${base}/api/harness/${encodeURIComponent(slug)}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

// Harnesses tab — list every harness in the device's workspace.
app.get('/harnesses', async (c) => {
  const claims = c.get('deviceClaims');
  const harnesses = await listHarnessesFor(claims.workspace_id);
  return c.json({ harnesses });
});

// Per-harness status (the detail screen consumes this). Uses the
// SAME shape the desktop /api/harness/:slug/status returns so the
// mobile Rust client + desktop both see identical fields (no schema
// drift, no per-surface decoder).
app.get('/harnesses/:slug', async (c) => {
  const claims = c.get('deviceClaims');
  const slug = c.req.param('slug');
  // Workspace check via the lite helper so we deny harnesses outside
  // the phone's paired workspace before paying for the FS reads.
  const inWs = await harnessExistsInWorkspace(claims.workspace_id, slug);
  if (!inWs) return c.json({ error: 'harness_not_in_workspace' }, 404);
  const { getHarnessStatusFull } = await import('./harness');
  const status = await getHarnessStatusFull(slug, undefined);
  if (!status) return c.json({ error: 'harness_not_found' }, 404);
  return c.json(status);
});

app.post('/harnesses/:slug/replan', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return shimHarnessAction(c, '/replan', 'POST', body);
});

app.post('/harnesses/:slug/smoke-test', async (c) => {
  return shimHarnessAction(c, '/smoke-test/run');
});

app.post('/harnesses/:slug/cleanup', async (c) => {
  return shimHarnessAction(c, '/cleanup');
});

/**
 * Mobile-JWT-authed log stream. Mirrors the desktop
 * /api/harness/{slug}/log/stream SSE shape (events: log/backfill-done/ping)
 * but routes auth through deviceAuth() rather than the session cookie.
 * Workspace check is enforced: the slug must belong to the phone's paired
 * workspace. Phase override via ?phase= (same as desktop).
 */
app.get('/harnesses/:slug/log/stream', async (c) => {
  const claims = c.get('deviceClaims');
  const slug = c.req.param('slug');
  if (!(await harnessExistsInWorkspace(claims.workspace_id, slug))) {
    return c.json({ error: 'harness_not_in_workspace' }, 404);
  }
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const jsonlPath = join(harnessDir(project), 'logs', 'run.log.jsonl');
  const tailSize = Math.min(Math.max(parseInt(c.req.query('tail') ?? '500', 10) || 500, 1), 5000);

  return streamSSE(c, async (stream) => {
    let aborted = false;
    const onAbort = () => { aborted = true; };

    // Backfill: read last 1 MiB of jsonl, replay up to tailSize valid lines
    // as `event: log`, then emit `event: backfill-done` with the count.
    let lastSize = 0;
    try {
      const stat = statSync(jsonlPath);
      const tailBytes = 1024 * 1024;
      const start = Math.max(0, stat.size - tailBytes);
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      const fd = openSync(jsonlPath, 'r');
      try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
      lastSize = stat.size;
      let chunk = buf.toString('utf8');
      if (start > 0) {
        const firstNl = chunk.indexOf('\n');
        if (firstNl >= 0) chunk = chunk.slice(firstNl + 1);
      }
      const allLines = chunk.split('\n').filter(Boolean);
      const toReplay = allLines.slice(-tailSize);
      let payload = '';
      let count = 0;
      for (const raw of toReplay) {
        try { JSON.parse(raw); payload += `event: log\ndata: ${raw}\n\n`; count++; }
        catch { /* skip malformed */ }
      }
      payload += `event: backfill-done\ndata: ${count}\n\n`;
      await stream.write(payload);
    } catch {
      await stream.writeSSE({ event: 'backfill-done', data: '0' });
    }
    void lastSize;

    // Live updates via the in-process log bus (run.sh log() POSTs to
    // /api/internal/log-event → publish(); we subscribe here).
    const { subscribe: logSubscribe } = await import('@/lib/harness-log-bus');
    const sub = logSubscribe(`${project.slug}:log`, (env) => {
      try { JSON.parse(env.line); }
      catch { return; }
      void stream.writeSSE({ event: 'log', data: env.line }).catch(() => { /* client gone */ });
    });
    for (const env of sub.recent) {
      try { JSON.parse(env.line); }
      catch { continue; }
      void stream.writeSSE({ event: 'log', data: env.line }).catch(() => { /* client gone */ });
    }

    try {
      while (true) {
        if (stream.aborted || aborted) break;
        await stream.sleep(15_000);
        await stream.writeSSE({ event: 'ping', data: '{}' });
      }
    } finally {
      sub.unsubscribe();
      onAbort();
    }
  });
});

// (Removed shim for /consolidate — the underlying operator route was
// dropped because scoper has no MODE=consolidate prompt section. Use
// /cleanup which covers the same intent and has a real prompt section.)

// Currently running — active operator scan + active harness phases.
app.get('/running', async (c) => {
  const claims = c.get('deviceClaims');
  return c.json(await currentlyRunning(claims.workspace_id));
});

// Recent actions / audit entries.

// Voice lease — cross-surface (desktop tabs + this phone) single-listener
// election. Phone always pre-empts on user tap. Heartbeat every 5s; lease
// expires after 12s of silence.




// WS_NOTE — voice WebSocket
//
// Hono on Next App Router can't natively upgrade WS. The existing pty router
// (apps/operator/app/api/_hono/pty.ts) handles WS via a separate `ws` server
// bound at startup. Mirror that pattern: register a `/api/mobile/voice` upgrade
// handler in the same place, validate the token from `?token=` query param
// using verifyDeviceToken(), then bridge frames into the existing voice-mode
// pipeline (apps/operator/app/_components/voice/voice-mode.ts).
//
// Stub here just to validate-and-reject if accessed via HTTP:
app.get('/voice', async (c) => {
  return c.json(
    { error: 'use_websocket', upgrade: 'wss://<host>/api/mobile/voice?token=...' },
    426,
  );
});

export const registerMobile = app;
