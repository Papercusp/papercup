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
import { getOrgPg } from '@restart/db-org';

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

  const { sql } = getOrgPg();

  // Invalidate any prior unconsumed tokens for this workspace. Keeps the
  // "one valid pair code at a time" mental model — the QR/payload on
  // screen is the only one that works, anything you copied earlier is
  // dead the moment you mint a fresh one.
  await sql`
    DELETE FROM harness_shared.mobile_pair_tokens
    WHERE workspace_id = ${opts.workspaceId}
      AND consumed = false
  `;

  await sql`
    INSERT INTO harness_shared.mobile_pair_tokens
      (pair_token, workspace_id, user_email, desktop_host, expires_at_ms, consumed, created_at_ms)
    VALUES (
      ${pairToken},
      ${opts.workspaceId},
      ${opts.userEmail ?? null},
      ${opts.desktopHost},
      ${expiresAt},
      false,
      ${now}
    )
  `;

  // Opportunistic GC: drop expired rows when the table grows.
  const cnt = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.mobile_pair_tokens
  `;
  if ((cnt[0]?.n ?? 0) > 1000) {
    await sql`DELETE FROM harness_shared.mobile_pair_tokens WHERE expires_at_ms < ${now}`;
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
  const { sql } = getOrgPg();
  const now = Date.now();
  const rows = await sql<
    {
      pair_token: string;
      workspace_id: string;
      user_email: string | null;
      desktop_host: string;
      expires_at_ms: number;
    }[]
  >`
    UPDATE harness_shared.mobile_pair_tokens
       SET consumed = true
     WHERE pair_token = ${pairToken}
       AND consumed = false
       AND expires_at_ms >= ${now}
    RETURNING pair_token, workspace_id, user_email, desktop_host, expires_at_ms
  `;
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
