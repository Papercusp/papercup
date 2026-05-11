/**
 * Mobile pair-token store — PG-backed (migration 031).
 *
 * Was previously a process-local `Map<string, PendingPair>` — lost on
 * operator restart and broken in multi-instance deploys (a pair POST
 * could land on a different instance from the one that minted the
 * token, returning unknown-pair).
 *
 * Tokens TTL 5 minutes; single-use. The consume operation is an
 * atomic UPDATE … WHERE consumed = false RETURNING to defeat replay
 * even under concurrent calls. Expired rows are swept opportunistically
 * during mint when the table grows beyond ~1000 entries.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { getOrgPg, generated } from '@restart/db-org';
import { and, eq, gte, lt, count } from 'drizzle-orm';

const t = generated.mobile_pair_tokensInHarness_shared;

interface PendingPair {
  pairToken: string;
  workspaceId: string;
  userEmail?: string;
  expiresAt: number;
  desktopHost: string;
}

const TTL_MS = Number(process.env.MOBILE_PAIR_TOKEN_TTL_SECONDS ?? 60 * 60) * 1000;

export async function mintPairToken(opts: {
  workspaceId: string;
  desktopHost: string;
  userEmail?: string;
}): Promise<{ pairToken: string; expiresAt: number }> {
  const pairToken = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TTL_MS;
  const now = Date.now();

  const { db } = getOrgPg();

  // No prior-token invalidation. Pair tokens are already one-time-use via
  // the `consumed` flag; multiple concurrent unconsumed tokens are fine,
  // and the GC below sweeps expired ones. The prior delete-on-mint caused
  // user-visible "pair token rejected" when two surfaces (desktop UI +
  // any helper script) minted around the same time — only the latest
  // mint survived, killing any earlier QR the user had screenshot.

  await db.insert(t).values({
    pair_token: pairToken,
    workspace_id: opts.workspaceId,
    user_email: opts.userEmail ?? null,
    desktop_host: opts.desktopHost,
    expires_at_ms: expiresAt,
    consumed: false,
    created_at_ms: now,
  });

  // Opportunistic GC.
  const cnt = await db.select({ n: count() }).from(t);
  if ((cnt[0]?.n ?? 0) > 1000) {
    await db.delete(t).where(lt(t.expires_at_ms, now));
  }

  return { pairToken, expiresAt };
}

/**
 * Atomically consume a pair token. Returns the row on success; null if
 * unknown, expired, or already consumed. Single round-trip via
 * UPDATE … WHERE consumed = false RETURNING — concurrent consumes can't
 * both succeed.
 */
export async function consumePairToken(pairToken: string): Promise<PendingPair | null> {
  const { db } = getOrgPg();
  const now = Date.now();
  const rows = await db
    .update(t)
    .set({ consumed: true })
    .where(and(eq(t.pair_token, pairToken), eq(t.consumed, false), gte(t.expires_at_ms, now)))
    .returning({
      pair_token: t.pair_token,
      workspace_id: t.workspace_id,
      user_email: t.user_email,
      desktop_host: t.desktop_host,
      expires_at_ms: t.expires_at_ms,
    });
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    pairToken: r.pair_token,
    workspaceId: r.workspace_id,
    userEmail: r.user_email ?? undefined,
    expiresAt: Number(r.expires_at_ms),
    desktopHost: r.desktop_host,
  };
}

export function newDeviceId(): string {
  return randomUUID();
}
