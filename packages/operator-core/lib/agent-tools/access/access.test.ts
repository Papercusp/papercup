/**
 * access:* tools (plan external-app-access-to-workspaces-2026-09-29 P-012, WI-10004025): a user
 * can ask an agent to list, create, pause and revoke outside-app keys, and only from this computer.
 *
 * The store is faked (its own suites cover it: connected-apps/store.integration.test.ts); these
 * tests pin what the TOOLS add — the local-only refusals, the secret never entering a result by
 * default, and the refusal mapping. The external-ingress case runs through the REAL ingress seam.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAsExternalIngress } from '../../auth/forwarded-request-trust';
import { APP_PRINCIPAL_SLUG_PREFIX } from '../../connected-apps/principal';
import { hardDenyReason } from '../../connected-apps/scope-policy';
import type { AppKeyRow, CreatedAppKey } from '../../connected-apps/store';
import { defaultAccessToolDeps, localOnlyRefusal } from './_shared';
import { accessCreate, accessList, accessRevoke, accessSetPaused, defaultAccessHandlerDeps, type AccessHandlerDeps } from './handlers';

const SECRET = `pcapp_${'k'.repeat(16)}_${'z'.repeat(43)}`;

function row(id: string, over: Partial<AppKeyRow> = {}): AppKeyRow {
  return {
    id,
    user_email: 'local@desktop',
    workspace_id: 'ws-1',
    kind: 'app',
    label: `app ${id}`,
    scopes: { tools: ['plans:list'] } as AppKeyRow['scopes'],
    limits: {},
    paired_at: new Date('2026-09-01T00:00:00Z'),
    expires_at: null,
    paused_at: null,
    revoked_at: null,
    last_seen: null,
    last_ip: null,
    spend_cap_cents: null,
    spend_cap_window_sec: null,
    rotated_at: null,
    previous_token_valid_until: null,
    ...over,
  };
}

class ScopeRefusal extends Error {
  problems = ['tool group "capability" is never grantable to an app key'];
}

function fakeDeps(over: Partial<AccessHandlerDeps> = {}) {
  const calls: string[] = [];
  const secretFiles = new Map<string, string>();
  const deps: AccessHandlerDeps = {
    externalIngressListener: () => null,
    appPrincipalPrefix: APP_PRINCIPAL_SLUG_PREFIX,
    listKeys: vi.fn(async () => {
      calls.push('list');
      return [row('a1'), row('a2', { revoked_at: new Date() }), row('a3', { paused_at: new Date() })];
    }),
    createKey: vi.fn(async (opts) => {
      calls.push('create');
      if (opts.tools?.includes('capability:bash')) throw new ScopeRefusal('scope');
      return { app: row('new1', { label: opts.label, kind: opts.kind ?? 'app' }), key: SECRET } as CreatedAppKey;
    }),
    setPaused: vi.fn(async (_ws, id) => {
      calls.push('pause');
      return id === 'a1';
    }),
    revoke: vi.fn(async (_ws, id) => {
      calls.push('revoke');
      return id === 'a1';
    }),
    workspaceExists: (id) => id === 'ws-1',
    writeSecretFile: vi.fn(async (id, secret) => {
      secretFiles.set(id, secret);
      return `/private/keys/${id}.key`;
    }),
    refusalOf: (err) => (err instanceof ScopeRefusal ? { error: 'invalid_scope', problems: err.problems } : null),
    ...over,
  };
  return { deps, calls, secretFiles };
}

const parse = (result: { content: Array<{ text: string }>; isError: boolean }) => JSON.parse(result.content[0]!.text);
const ALL = (deps: AccessHandlerDeps, ctx?: Parameters<typeof accessList>[1]) => [
  accessList({ workspaceId: 'ws-1' }, ctx, deps),
  accessCreate({ workspaceId: 'ws-1', label: 'x', tools: ['plans:list'] }, ctx, deps),
  accessSetPaused({ workspaceId: 'ws-1', id: 'a1', paused: true }, ctx, deps),
  accessRevoke({ workspaceId: 'ws-1', id: 'a1' }, ctx, deps),
];

describe('access:* are local-only', () => {
  it('refuses every access tool for an app-key caller, before touching the store', async () => {
    const { deps, calls } = fakeDeps();
    const ctx = { principal: { slug: `${APP_PRINCIPAL_SLUG_PREFIX}a1`, workspaceId: 'ws-1' } };
    for (const result of await Promise.all(ALL(deps, ctx))) {
      expect(result.isError).toBe(true);
      expect(parse(result)).toEqual({ ok: false, error: 'local_only', reason: 'app_key_caller' });
    }
    expect(calls).toEqual([]);
  });

  it('refuses every access tool for a request that arrived through external ingress', async () => {
    const { deps, calls } = fakeDeps({ externalIngressListener: () => 'external-ingress:4443' });
    for (const result of await Promise.all(ALL(deps))) {
      expect(parse(result)).toEqual({ ok: false, error: 'local_only', reason: 'external_ingress' });
    }
    expect(calls).toEqual([]);
  });

  it('no app key can ever be scoped to an access tool (the group is hard-denied)', () => {
    for (const name of ['access:list', 'access:create', 'access:pause', 'access:revoke']) {
      expect(hardDenyReason({ name, capabilities: [name === 'access:list' ? 'operator:read' : 'operator:write'] })).toMatch(/never grantable/);
    }
  });

  it('reads external ingress from the real listener seam, and allows a local call', async () => {
    const real = await defaultAccessToolDeps();
    expect(localOnlyRefusal(undefined, real)).toBeNull();
    expect(localOnlyRefusal({ principal: { slug: 'system:superuser' } }, real)).toBeNull();
    expect(runAsExternalIngress('tunnel', () => localOnlyRefusal(undefined, real))).toBe('external_ingress');
    expect(localOnlyRefusal({ principal: { slug: `${APP_PRINCIPAL_SLUG_PREFIX}x` } }, real)).toBe('app_key_caller');
  });
});

describe('access:list', () => {
  it('lists live keys with status and creator, and never a secret or hash', async () => {
    const { deps } = fakeDeps();
    const body = parse(await accessList({ workspaceId: 'ws-1' }, undefined, deps));
    expect(body.count).toBe(2);
    expect(body.keys.map((k: { id: string; status: string }) => [k.id, k.status])).toEqual([['a1', 'active'], ['a3', 'paused']]);
    expect(body.keys[0].createdBy).toBe('local@desktop');
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/token_hash|pcapp_/);
  });

  it('includes revoked keys only when asked', async () => {
    const { deps } = fakeDeps();
    const body = parse(await accessList({ workspaceId: 'ws-1', includeRevoked: true }, undefined, deps));
    expect(body.keys.find((k: { id: string }) => k.id === 'a2').status).toBe('revoked');
  });
});

describe('access:create', () => {
  it('writes the secret to a private file and keeps it out of the result', async () => {
    const { deps, secretFiles } = fakeDeps();
    const result = await accessCreate({ workspaceId: 'ws-1', label: 'Zapier', tools: ['plans:list'] }, undefined, deps);
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).not.toContain(SECRET);
    const body = parse(result);
    expect(body).toMatchObject({ ok: true, secretFile: '/private/keys/new1.key', key: { id: 'new1', label: 'Zapier' } });
    expect(secretFiles.get('new1')).toBe(SECRET);
    expect(deps.createKey).toHaveBeenCalledWith(expect.objectContaining({ userEmail: 'local@desktop', workspaceId: 'ws-1', kind: 'app' }));
  });

  it('returns the secret inline only when revealSecret is set, and then writes no file', async () => {
    const { deps } = fakeDeps();
    const body = parse(await accessCreate({ workspaceId: 'ws-1', label: 'x', tools: ['plans:list'], revealSecret: true }, undefined, deps));
    expect(body.secret).toBe(SECRET);
    expect(deps.writeSecretFile).not.toHaveBeenCalled();
  });

  it('maps a scope refusal and an unknown workspace to typed errors', async () => {
    const { deps } = fakeDeps();
    expect(parse(await accessCreate({ workspaceId: 'ws-1', label: 'x', tools: ['capability:bash'] }, undefined, deps)))
      .toMatchObject({ ok: false, error: 'invalid_scope', problems: [expect.stringContaining('never grantable')] });
    expect(parse(await accessCreate({ workspaceId: 'ws-9', label: 'x' }, undefined, deps)))
      .toEqual({ ok: false, error: 'workspace_not_found', workspaceId: 'ws-9' });
    expect(parse(await accessCreate({ workspaceId: 'ws-1', label: 'x', expiresAt: 'not-a-date' }, undefined, deps)))
      .toEqual({ ok: false, error: 'invalid_expires_at' });
  });

  it('passes a service key and its spending cap through to the store', async () => {
    const { deps } = fakeDeps();
    await accessCreate({ workspaceId: 'ws-1', label: 'nightly', kind: 'service', tools: ['plans:list'], spendCapCents: 500 }, undefined, deps);
    expect(deps.createKey).toHaveBeenCalledWith(expect.objectContaining({ kind: 'service', spendCapCents: 500 }));
  });
});

describe('access:pause and access:revoke', () => {
  it('pause and resume a live key; an unknown id is key_not_found', async () => {
    const { deps } = fakeDeps();
    expect(parse(await accessSetPaused({ workspaceId: 'ws-1', id: 'a1', paused: true }, undefined, deps))).toEqual({ ok: true, id: 'a1', paused: true });
    expect(parse(await accessSetPaused({ workspaceId: 'ws-1', id: 'a1', paused: false }, undefined, deps))).toEqual({ ok: true, id: 'a1', paused: false });
    expect(parse(await accessSetPaused({ workspaceId: 'ws-1', id: 'zz', paused: true }, undefined, deps))).toEqual({ ok: false, error: 'key_not_found', id: 'zz' });
    expect(deps.setPaused).toHaveBeenCalledWith('ws-1', 'a1', false);
  });

  it('revokes a live key; an unknown or already-revoked id is key_not_found', async () => {
    const { deps } = fakeDeps();
    expect(parse(await accessRevoke({ workspaceId: 'ws-1', id: 'a1' }, undefined, deps))).toEqual({ ok: true, id: 'a1', revoked: true });
    expect(parse(await accessRevoke({ workspaceId: 'ws-1', id: 'a2' }, undefined, deps))).toEqual({ ok: false, error: 'key_not_found', id: 'a2' });
  });
});

describe('the real secret file', () => {
  let dir: string | null = null;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('is created readable only by this account and is never overwritten', async () => {
    dir = await mkdtemp(join(tmpdir(), 'access-keys-'));
    vi.stubEnv('PAPERCUSP_ACCESS_KEY_DIR', dir);
    const deps = await defaultAccessHandlerDeps(await defaultAccessToolDeps());
    const file = await deps.writeSecretFile('k1', SECRET);
    expect(file).toBe(join(dir, 'k1.key'));
    expect(await readFile(file, 'utf8')).toBe(`${SECRET}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(deps.writeSecretFile('k1', 'other')).rejects.toThrow(/EEXIST/);
  });
});
