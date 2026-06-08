/**
 * POST /cupboard/install-deps — the install-loop wiring
 * (tool-distribution-discovery-2026-06-08 P-002).
 *
 * The loop core (resolveAndInstallDeps) is unit-tested separately; here we pin
 * the ROUTE's job: parse `deps` / `blueprintId` / `blueprint` into a declared
 * set, run the loop, and return its result — with input validation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cupboard/resolve-and-install', () => ({
  resolveAndInstallDeps: vi.fn(async () => ({
    ok: true,
    installed: [{ name: 'md-tools', kind: 'pack', listingId: 'lid-md-tools', tools: ['md.render'] }],
    stillMissing: { tools: [], packs: [], plugins: [] },
    advisory: [],
    rounds: 1,
  })),
}));
vi.mock('../../cupboard/pack-catalog', () => ({ derivePackCatalog: vi.fn() }));
vi.mock('../../cupboard/install-io', () => ({ installCupboardUnitFromListing: vi.fn() }));
vi.mock('../../blueprint/installed-blueprints', () => ({
  operatorResolveExtends: vi.fn(() => (id: string) => (id === 'known' ? '/installed/known' : null)),
}));
vi.mock('../../agent-tools/blueprint/_resolve', () => ({ resolveAndValidate: vi.fn() }));

import route from '../routes/cupboard-install-deps';
import { resolveAndInstallDeps } from '../../cupboard/resolve-and-install';
import { resolveAndValidate } from '../../agent-tools/blueprint/_resolve';

function post(body: unknown): Promise<Response> {
  const req = new Request('http://localhost/cupboard/install-deps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (route as { handler: (req: Request) => Promise<Response> }).handler(req);
}

beforeEach(() => {
  vi.mocked(resolveAndInstallDeps).mockClear();
  vi.mocked(resolveAndValidate).mockReset();
});

describe('POST /cupboard/install-deps', () => {
  it('runs the loop for an explicit `deps` set and returns its result', async () => {
    const res = await post({ deps: { tools: ['md.render'] } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; installed: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.installed).toHaveLength(1);
    expect(resolveAndInstallDeps).toHaveBeenCalledWith(
      { tools: ['md.render'], packs: [], plugins: [] },
      expect.objectContaining({ deriveCatalog: expect.any(Function), installUnit: expect.any(Function) }),
    );
  });

  it('reads a blueprint\'s declared deps and runs the loop on them', async () => {
    vi.mocked(resolveAndValidate).mockReturnValue({
      ok: true,
      parseError: null,
      blueprint: { dependencies: { tools: ['need.tool'], packs: ['p'], plugins: [] } },
    } as never);
    const res = await post({ blueprintId: 'known' });
    expect(res.status).toBe(200);
    expect(resolveAndInstallDeps).toHaveBeenCalledWith(
      { tools: ['need.tool'], packs: ['p'], plugins: [] },
      expect.anything(),
    );
  });

  it('400s when neither deps nor a blueprint is given', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(resolveAndInstallDeps).not.toHaveBeenCalled();
  });

  it('422s on an invalid blueprint', async () => {
    vi.mocked(resolveAndValidate).mockReturnValue({
      ok: false,
      parseError: null,
      validation: { errors: [{ code: 'x', message: 'bad' }] },
    } as never);
    const res = await post({ blueprint: { id: 'b', spine: 'nope' } });
    expect(res.status).toBe(422);
    expect(resolveAndInstallDeps).not.toHaveBeenCalled();
  });

  it('404s when a blueprintId resolves to no known blueprint', async () => {
    vi.mocked(resolveAndValidate).mockReturnValue({ ok: true, parseError: null, blueprint: { dependencies: {} } } as never);
    const res = await post({ blueprintId: 'ghost' });
    expect(res.status).toBe(404);
  });

  it('400s on invalid JSON', async () => {
    const req = new Request('http://localhost/cupboard/install-deps', { method: 'POST', body: '{not json' });
    const res = await (route as { handler: (req: Request) => Promise<Response> }).handler(req);
    expect(res.status).toBe(400);
  });
});
