/**
 * Cross-surface voice lease — only one device "listens" at a time.
 *
 * Problem: the existing `voice-leader.ts` is a BroadcastChannel
 * intra-browser election. It can't see a paired phone, so if a desktop
 * tab is leader AND the phone has voice mode on, the user gets stereo
 * responses to "hey operator …".
 *
 * Solution: a per-workspace lease stored in `harness_shared.voice_lease`
 * with a 12s heartbeat-based expiry (same cadence as voice-leader). Any
 * client that wants to listen claims the lease; when a new client claims
 * it, we emit `voiceLease.current` on the sync-invalidate channel so
 * existing listeners (desktop tabs subscribed via the SSE stream)
 * silently demote.
 *
 * Phone is the natural pre-empter: when the user taps the FAB on the
 * phone, they want the phone to listen — desktop yields. Same for the
 * inverse direction.
 *
 * The server is the source of truth. Browsers and phones both call
 * REST endpoints; no special protocol.
 */
import { getOrgPg, generated } from '@restart/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { notifySyncInvalidate } from './sync-sse';

const vl = generated.voice_leaseInHarness_shared;

const LEASE_MS = 12_000;

export type VoiceLeaseKind = 'desktop' | 'mobile';

export interface VoiceLease {
  workspaceId: string;
  ownerId: string;        // tabId for desktop, deviceId for mobile
  ownerKind: VoiceLeaseKind;
  expiresAtMs: number;
}

let ensured = false;
async function ensureLeaseTable(): Promise<void> {
  if (ensured) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.voice_lease (
      workspace_id   TEXT PRIMARY KEY,
      owner_id       TEXT NOT NULL,
      owner_kind     TEXT NOT NULL CHECK (owner_kind IN ('desktop','mobile')),
      expires_at_ms  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS voice_lease_expires_idx
      ON harness_shared.voice_lease (expires_at_ms);
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON harness_shared.voice_lease TO harness_app;
  `);
  ensured = true;
}

/**
 * Claim or refresh the lease for a workspace. Behavior:
 *  - No row OR row expired → INSERT/UPSERT this owner; return success.
 *  - Same owner → refresh expiry; return success.
 *  - Different owner with valid lease → return current owner without
 *    modifying. Caller decides whether to pre-empt (mobile always pre-empts;
 *    desktop yields).
 *
 * Pre-emption mode (`force: true`) overwrites any active lease. The phone
 * uses this on user tap; desktops use it when the user explicitly toggles
 * voice on (signaling intent).
 */
export async function claimVoiceLease(opts: {
  workspaceId: string;
  ownerId: string;
  ownerKind: VoiceLeaseKind;
  force?: boolean;
}): Promise<{ granted: boolean; lease: VoiceLease }> {
  await ensureLeaseTable();
  const { db } = getOrgPg();
  const now = Date.now();
  const expiresAtMs = now + LEASE_MS;

  if (opts.force) {
    await db
      .insert(vl)
      .values({
        workspace_id: opts.workspaceId,
        owner_id: opts.ownerId,
        owner_kind: opts.ownerKind,
        expires_at_ms: expiresAtMs,
      })
      .onConflictDoUpdate({
        target: vl.workspace_id,
        set: {
          owner_id: dsql`EXCLUDED.owner_id`,
          owner_kind: dsql`EXCLUDED.owner_kind`,
          expires_at_ms: dsql`EXCLUDED.expires_at_ms`,
        },
      });
    void notifySyncInvalidate('voiceLease.current', { workspaceId: opts.workspaceId });
    return {
      granted: true,
      lease: {
        workspaceId: opts.workspaceId,
        ownerId: opts.ownerId,
        ownerKind: opts.ownerKind,
        expiresAtMs,
      },
    };
  }

  const rows = await db
    .select({
      owner_id: vl.owner_id,
      owner_kind: vl.owner_kind,
      expires_at_ms: vl.expires_at_ms,
    })
    .from(vl)
    .where(eq(vl.workspace_id, opts.workspaceId));
  const current = rows[0] as { owner_id: string; owner_kind: VoiceLeaseKind; expires_at_ms: number } | undefined;
  const expired = !current || Number(current.expires_at_ms) < now;
  const same = current && current.owner_id === opts.ownerId;

  if (expired || same) {
    await db
      .insert(vl)
      .values({
        workspace_id: opts.workspaceId,
        owner_id: opts.ownerId,
        owner_kind: opts.ownerKind,
        expires_at_ms: expiresAtMs,
      })
      .onConflictDoUpdate({
        target: vl.workspace_id,
        set: {
          owner_id: dsql`EXCLUDED.owner_id`,
          owner_kind: dsql`EXCLUDED.owner_kind`,
          expires_at_ms: dsql`EXCLUDED.expires_at_ms`,
        },
      });
    if (expired || (current && current.owner_id !== opts.ownerId)) {
      void notifySyncInvalidate('voiceLease.current', { workspaceId: opts.workspaceId });
    }
    return {
      granted: true,
      lease: {
        workspaceId: opts.workspaceId,
        ownerId: opts.ownerId,
        ownerKind: opts.ownerKind,
        expiresAtMs,
      },
    };
  }

  return {
    granted: false,
    lease: {
      workspaceId: opts.workspaceId,
      ownerId: current.owner_id,
      ownerKind: current.owner_kind,
      expiresAtMs: Number(current.expires_at_ms),
    },
  };
}

export async function releaseVoiceLease(opts: {
  workspaceId: string;
  ownerId: string;
}): Promise<void> {
  await ensureLeaseTable();
  const { db } = getOrgPg();
  await db.delete(vl).where(and(eq(vl.workspace_id, opts.workspaceId), eq(vl.owner_id, opts.ownerId)));
  void notifySyncInvalidate('voiceLease.current', { workspaceId: opts.workspaceId });
}

export async function readVoiceLease(workspaceId: string): Promise<VoiceLease | null> {
  await ensureLeaseTable();
  const { db } = getOrgPg();
  const rows = await db
    .select({
      owner_id: vl.owner_id,
      owner_kind: vl.owner_kind,
      expires_at_ms: vl.expires_at_ms,
    })
    .from(vl)
    .where(and(eq(vl.workspace_id, workspaceId), dsql`${vl.expires_at_ms} >= ${Date.now()}`));
  if (rows.length === 0) return null;
  const r = rows[0] as { owner_id: string; owner_kind: VoiceLeaseKind; expires_at_ms: number };
  return {
    workspaceId,
    ownerId: r.owner_id,
    ownerKind: r.owner_kind,
    expiresAtMs: Number(r.expires_at_ms),
  };
}
