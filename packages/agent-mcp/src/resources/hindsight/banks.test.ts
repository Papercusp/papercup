/**
 * `papercusp://hindsight/banks` resource — companyId resolution + degraded
 * envelope.
 *
 * `@papercusp/host-platform` is mocked so the workspace registry file is a
 * controllable fixture. The logic under test:
 *   - a registry entry with a companyId → one `paperclip::<companyId>` bank
 *   - no registry file / no matching workspace / null companyId / corrupt
 *     JSON → `{ banks: [], degraded: true }` with the configuration reason
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let registryText: string | null = null;

vi.mock('@papercusp/host-platform', () => ({
  getHostPlatform: () => ({
    homedir: () => '/home/test',
    readTextFileSync: (_path: string) => registryText,
  }),
}));

import resource from './banks';

const CTX = (workspaceId = 'ws_1') =>
  ({
    principal: { slug: 'op', workspaceId },
    tx: {} as never,
    log: vi.fn(),
  }) as never;

const URI = 'papercusp://hindsight/banks';

function payload(res: { text?: string }) {
  return JSON.parse(res.text!) as { banks: unknown[]; degraded?: boolean; degradedReason?: string };
}

beforeEach(() => {
  registryText = null;
});

describe('hindsight:banks resource', () => {
  it('derives the paperclip bank from the workspace companyId', async () => {
    registryText = JSON.stringify({
      workspaces: [
        { id: 'other', name: 'Other', companyId: 'not-me' },
        { id: 'ws_1', name: 'Mine', companyId: 'acme-42' },
      ],
    });
    const res = await resource.read(URI, CTX());
    expect(payload(res)).toEqual({
      banks: [{ id: 'paperclip::acme-42', kind: 'paperclip', companyId: 'acme-42' }],
    });
    expect(res.mimeType).toBe('application/json');
  });

  it('degrades when the registry file is missing', async () => {
    registryText = null;
    const p = payload(await resource.read(URI, CTX()));
    expect(p.banks).toEqual([]);
    expect(p.degraded).toBe(true);
    expect(p.degradedReason).toMatch(/no companyId/);
  });

  it('degrades when the workspace has no entry or a null companyId', async () => {
    registryText = JSON.stringify({
      workspaces: [{ id: 'ws_1', name: 'Mine', companyId: null }],
    });
    expect(payload(await resource.read(URI, CTX())).degraded).toBe(true);
    expect(payload(await resource.read(URI, CTX('unknown-ws'))).degraded).toBe(true);
  });

  it('degrades on corrupt registry JSON instead of throwing', async () => {
    registryText = '{not json';
    const p = payload(await resource.read(URI, CTX()));
    expect(p).toMatchObject({ banks: [], degraded: true });
  });
});
