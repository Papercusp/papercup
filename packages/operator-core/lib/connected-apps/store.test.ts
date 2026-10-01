/**
 * store.test.ts — the app-key store reads timestamps that a drizzle-wrapped pool returns as TEXT
 * (WI-10004453, follow-up to WI-10004446).
 *
 * Once anything wraps the shared postgres-js client with drizzle, a raw `timestamptz` read comes
 * back in Postgres' text form instead of a `Date` (./pg-dates.ts). Before the fix, store.ts trusted
 * `Date` and three things went wrong:
 *   - a rotated key's PREVIOUS secret was refused inside its grace window, because
 *     `previousKeyStillValid` checks `instanceof Date` (reason 'rotated' instead of ok);
 *   - an expiring key or access token threw on `expires_at.getTime()` instead of being refused;
 *   - `listAppKeys` handed text to callers that expect a `Date`.
 * The fake pool below answers every query the way that pool does, so the store itself has to turn
 * the text into Dates. The real-Postgres behaviour of these queries is in ./store.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const h = vi.hoisted(() => ({ rowsFor: (_query: string): Record<string, unknown>[] => [] }));

vi.mock('@papercusp/db-org', async (orig) => {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ''), '');
    return Promise.resolve(h.rowsFor(query));
  };
  const sql: Sql = Object.assign(tag, {
    unsafe: (text: string) => text,
    begin: <T>(cb: (tx: Sql) => Promise<T>) => cb(sql),
  }) as unknown as Sql;
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql }),
    withWorkspace: <T>(_ws: string, cb: (tx: Sql) => Promise<T>) => cb(sql),
  };
});
// A refused known key is counted toward the auth-failure alert (P-328); keep that off the database.
vi.mock('./alert-sweep', () => ({ recordAppKeyAuthFailure: vi.fn() }));

const { listAppKeys, loadAccessTokenScopeRow, loadAppScopeRow, verifyAppKey } = await import('./store');
const { mintAccessToken, mintAppKey } = await import('./key');

const NOW = new Date('2026-09-30T12:00:00Z');
/** Postgres' text form, in the two offsets the operator's pools actually produce. */
const PAIRED = '2026-09-01 00:00:00+00';
const IN_AN_HOUR = '2026-09-30 09:00:00.25-04'; // 13:00:00.250Z
const AN_HOUR_AGO = '2026-09-30 11:00:00.123456+00';

function keyRow(over: Record<string, unknown> = {}) {
  const minted = mintAppKey();
  const row: Record<string, unknown> = {
    id: minted.id,
    user_email: 'owner@example.test',
    workspace_id: 'ws-text',
    kind: 'app',
    label: 'text-timestamp key',
    scopes: { capabilities: [], tools: ['plans:*'] },
    limits: {},
    paired_at: PAIRED,
    expires_at: null,
    paused_at: null,
    revoked_at: null,
    last_seen: null,
    last_ip: null,
    spend_cap_cents: null,
    spend_cap_window_sec: null,
    rotated_at: null,
    previous_token_valid_until: null,
    client_auth: null,
    token_hash: minted.tokenHash,
    previous_token_hash: null,
    remote_access_enabled: true,
    ...over,
  };
  return { row, key: minted.key, minted };
}

describe('app-key store: text timestamps from a drizzle-wrapped pool (WI-10004453)', () => {
  beforeEach(() => {
    h.rowsFor = () => [];
  });

  it('accepts a rotated key’s previous secret inside its grace window', async () => {
    const previous = mintAppKey();
    const current = mintAppKey(previous.id);
    const { row } = keyRow({
      id: previous.id,
      token_hash: current.tokenHash,
      previous_token_hash: previous.tokenHash,
      rotated_at: AN_HOUR_AGO,
      previous_token_valid_until: IN_AN_HOUR,
    });
    h.rowsFor = () => [row];

    const verdict = await verifyAppKey(previous.key, NOW);

    expect(verdict).toMatchObject({ ok: true, viaPreviousKey: true });
    if (!verdict.ok) throw new Error('unreachable');
    expect(verdict.app.previous_token_valid_until).toEqual(new Date('2026-09-30T13:00:00.250Z'));
    expect(verdict.app.rotated_at).toBeInstanceOf(Date);
    expect(verdict.app.paired_at).toEqual(new Date('2026-09-01T00:00:00Z'));
  });

  it('refuses the previous secret once its grace window has passed', async () => {
    const previous = mintAppKey();
    const current = mintAppKey(previous.id);
    const { row } = keyRow({
      id: previous.id,
      token_hash: current.tokenHash,
      previous_token_hash: previous.tokenHash,
      previous_token_valid_until: AN_HOUR_AGO,
    });
    h.rowsFor = () => [row];

    await expect(verifyAppKey(previous.key, NOW)).resolves.toEqual({ ok: false, reason: 'rotated' });
  });

  it('refuses an expired key as expired instead of throwing', async () => {
    const { row, key } = keyRow({ expires_at: AN_HOUR_AGO });
    h.rowsFor = () => [row];

    await expect(verifyAppKey(key, NOW)).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('verifies an access token whose expiry and parent timestamps arrive as text', async () => {
    const { row: parent } = keyRow({ kind: 'service', client_auth: 'client_secret', spend_cap_cents: 500 });
    const token = mintAccessToken();
    const tokenRow = {
      id: token.id,
      token_hash: token.tokenHash,
      app_id: parent.id,
      scopes: parent.scopes,
      expires_at: IN_AN_HOUR,
    };
    h.rowsFor = (query) => (query.includes('connected_app_access_tokens') ? [tokenRow] : [parent]);

    const verdict = await verifyAppKey(token.key, NOW);

    expect(verdict).toMatchObject({ ok: true, viaPreviousKey: false, accessToken: { id: token.id } });
    if (!verdict.ok) throw new Error('unreachable');
    expect(verdict.accessToken?.expires_at).toEqual(new Date('2026-09-30T13:00:00.250Z'));
    expect(verdict.app.paired_at).toBeInstanceOf(Date);
  });

  it('refuses an expired access token as expired instead of throwing', async () => {
    const { row: parent } = keyRow({ kind: 'service', client_auth: 'client_secret', spend_cap_cents: 500 });
    const token = mintAccessToken();
    const tokenRow = { id: token.id, token_hash: token.tokenHash, app_id: parent.id, scopes: {}, expires_at: AN_HOUR_AGO };
    h.rowsFor = (query) => (query.includes('connected_app_access_tokens') ? [tokenRow] : [parent]);

    await expect(verifyAppKey(token.key, NOW)).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('lists keys with every timestamp as a Date', async () => {
    const { row } = keyRow({ last_seen: AN_HOUR_AGO, paused_at: AN_HOUR_AGO, expires_at: IN_AN_HOUR });
    h.rowsFor = () => [row];

    const [listed] = await listAppKeys('ws-text');

    expect(listed?.paired_at).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(listed?.last_seen).toEqual(new Date('2026-09-30T11:00:00.123Z'));
    expect(listed?.paused_at).toBeInstanceOf(Date);
    expect(listed?.expires_at).toEqual(new Date('2026-09-30T13:00:00.250Z'));
    expect(listed?.revoked_at).toBeNull();
  });

  it('reads the dispatch seat’s scope rows with Date timestamps', async () => {
    h.rowsFor = () => [
      { id: 'k', workspace_id: 'ws-text', scopes: {}, revoked_at: null, paused_at: AN_HOUR_AGO, expires_at: IN_AN_HOUR },
    ];
    const scope = await loadAppScopeRow('k');
    expect(scope?.paused_at).toBeInstanceOf(Date);
    expect(scope?.expires_at).toEqual(new Date('2026-09-30T13:00:00.250Z'));

    h.rowsFor = () => [
      {
        id: 'k',
        workspace_id: 'ws-text',
        scopes: {},
        revoked_at: null,
        paused_at: null,
        expires_at: IN_AN_HOUR,
        token_expires_at: AN_HOUR_AGO,
      },
    ];
    const tokenScope = await loadAccessTokenScopeRow('t', 'k');
    // The earlier of the parent's and the token's expiry.
    expect(tokenScope?.expires_at).toEqual(new Date('2026-09-30T11:00:00.123Z'));
  });

  it('throws naming the column when a timestamp column holds something that is not one', async () => {
    const { row, key } = keyRow({ previous_token_valid_until: 'not-a-time' });
    h.rowsFor = () => [row];

    await expect(verifyAppKey(key, NOW)).rejects.toThrow(/connected_apps\.previous_token_valid_until is not a timestamp/);
  });
});
