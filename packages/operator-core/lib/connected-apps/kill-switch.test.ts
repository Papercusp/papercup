/**
 * kill-switch.test.ts — the Remote access switch refuses every outside credential
 * (external-app-access-to-workspaces-2026-09-29 P-010, R-24; decision D-025).
 *
 * R-24: "With remote access switched off, every connected-app key is refused on its next request."
 * The verdict functions are pure, so every credential kind is checked here without a database:
 *   - an app key (kind 'app') and a service key (kind 'service') presented as a bearer;
 *   - a client-credentials access token (pcat_), whose principal is its parent service key;
 *   - the token endpoint's own client check (`at: 'token-endpoint'`), so a switched-off workspace
 *     cannot mint new tokens either.
 * The same row turned back on authenticates again, which is the positive control for each case:
 * the refusal is the switch, not something else about the fixture.
 *
 * The SQL that reads the switch with the key (migration 1263, store.ts REMOTE_ACCESS_COLUMN) is
 * covered against real Postgres by ./kill-switch.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { mintAccessToken, mintAppKey } from './key';
import {
  accessTokenVerdictOf,
  appKeyVerdictOf,
  type AppKeyKind,
  type StoredAccessTokenRow,
  type StoredAppKeyRow,
} from './store';

const NOW = new Date('2026-09-30T12:00:00Z');

function keyRow(kind: AppKeyKind, over: Partial<StoredAppKeyRow> = {}): { row: StoredAppKeyRow; key: string } {
  const minted = mintAppKey();
  const row: StoredAppKeyRow = {
    id: minted.id,
    user_email: 'owner@example.test',
    workspace_id: 'ws-kill',
    kind,
    label: `${kind} key`,
    scopes: { capabilities: [], tools: ['plans:*'] },
    limits: {},
    paired_at: new Date('2026-09-01T00:00:00Z'),
    expires_at: null,
    paused_at: null,
    revoked_at: null,
    last_seen: null,
    last_ip: null,
    spend_cap_cents: kind === 'service' ? 500 : null,
    spend_cap_window_sec: null,
    rotated_at: null,
    previous_token_valid_until: null,
    client_auth: null,
    token_hash: minted.tokenHash,
    previous_token_hash: null,
    remote_access_enabled: true,
    ...over,
  };
  return { row, key: minted.key };
}

function accessToken(parent: StoredAppKeyRow): { stored: StoredAccessTokenRow; key: string } {
  const t = mintAccessToken();
  return {
    stored: {
      id: t.id,
      token_hash: t.tokenHash,
      app_id: parent.id,
      scopes: parent.scopes,
      expires_at: new Date(NOW.getTime() + 30 * 60_000),
    },
    key: t.key,
  };
}

const OFF = { ok: false, reason: 'remote_access_off' } as const;

describe('R-24: the Remote access switch refuses every connected-app credential', () => {
  it.each<AppKeyKind>(['app', 'service'])('a %s key is refused while the switch is off, and works once it is on', (kind) => {
    const { row, key } = keyRow(kind);
    expect(appKeyVerdictOf({ ...row, remote_access_enabled: false }, key, NOW)).toEqual(OFF);
    expect(appKeyVerdictOf(row, key, NOW)).toMatchObject({ ok: true, app: { id: row.id } });
  });

  it('a client-credentials access token is refused while its workspace switch is off', () => {
    const { row } = keyRow('service', { client_auth: 'client_secret' });
    const t = accessToken(row);
    const { token_hash: _h, previous_token_hash: _p, ...parent } = row;
    expect(accessTokenVerdictOf(t.stored, { ...parent, remote_access_enabled: false }, t.key, NOW)).toEqual(OFF);
    expect(accessTokenVerdictOf(t.stored, parent, t.key, NOW)).toMatchObject({ ok: true, accessToken: { id: t.stored.id } });
  });

  it('the token endpoint refuses the client itself, so no new token can be minted while off', () => {
    const { row, key } = keyRow('service', { client_auth: 'client_secret' });
    expect(appKeyVerdictOf({ ...row, remote_access_enabled: false }, key, NOW, { at: 'token-endpoint' })).toEqual(OFF);
    expect(appKeyVerdictOf(row, key, NOW, { at: 'token-endpoint' })).toMatchObject({ ok: true });
  });

  it('fails closed: a row whose switch value is missing is refused', () => {
    const { row, key } = keyRow('app');
    const { remote_access_enabled: _on, ...withoutSwitch } = row;
    expect(appKeyVerdictOf(withoutSwitch as unknown as StoredAppKeyRow, key, NOW)).toEqual(OFF);
  });

  it('only a holder of the real secret learns the switch is off: a wrong secret is still a mismatch', () => {
    const { row } = keyRow('app', { remote_access_enabled: false });
    const other = mintAppKey(row.id);
    expect(appKeyVerdictOf(row, other.key, NOW)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it("a key's own state outranks the switch: revoked, paused and expired keys report their own reason", () => {
    const off = { remote_access_enabled: false };
    const revoked = keyRow('app', { ...off, revoked_at: NOW });
    const paused = keyRow('app', { ...off, paused_at: NOW });
    const expired = keyRow('app', { ...off, expires_at: NOW });
    expect(appKeyVerdictOf(revoked.row, revoked.key, NOW)).toEqual({ ok: false, reason: 'revoked' });
    expect(appKeyVerdictOf(paused.row, paused.key, NOW)).toEqual({ ok: false, reason: 'paused' });
    expect(appKeyVerdictOf(expired.row, expired.key, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('the verdict never carries the switch value as part of the app row', () => {
    const { row, key } = keyRow('app');
    const verdict = appKeyVerdictOf(row, key, NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(Object.keys(verdict.app)).not.toContain('remote_access_enabled');
  });
});
