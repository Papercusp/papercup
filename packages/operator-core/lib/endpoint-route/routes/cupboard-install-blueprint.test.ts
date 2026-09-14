import { beforeEach, describe, expect, it, vi } from 'vitest';
import route from './cupboard-install-blueprint';
import { installBlueprintFromCupboard } from '../../cupboard/install-blueprint-io';

vi.mock('../../cupboard/install-blueprint-io', () => ({ installBlueprintFromCupboard: vi.fn() }));
const install = vi.mocked(installBlueprintFromCupboard);
const refusal = {
  ok: false as const, status: 403, error: 'capability_unsatisfied',
  detail: 'crm.email@1.0.0: outside-ceiling',
  data: { failures: [{ classRef: 'crm.email@1.0.0', cause: 'outside-ceiling' }] },
};

async function call(body: unknown) {
  return (route as unknown as { handler(req: Request): Promise<Response> }).handler(
    new Request('http://localhost/api/cupboard/install-blueprint', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  install.mockReset();
  install.mockResolvedValue(refusal);
});

describe('P-005 public installer target role', () => {
  it('forwards the explicit target and preserves the structured permission refusal', async () => {
    const response = await call({ listingId: 'identity', potSlug: 'sales', capabilityRole: '  read-only  ' });
    expect(install).toHaveBeenCalledWith({
      listingId: 'identity', installPlugins: false, potSlug: 'sales',
      capabilityRole: 'read-only', capabilityMode: 'interactive',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false, error: refusal.error, detail: refusal.detail, data: refusal.data,
    });
  });

  it('leaves role omission to the authoritative single-role resolver, not a privileged default', async () => {
    await call({ listingId: 'identity', potSlug: 'sales' });
    expect(install.mock.calls[0][0]).not.toHaveProperty('capabilityRole');
  });

  it.each(['', '   ', 42, null, [], {}, 'x'.repeat(121)])('refuses invalid role %j before installer execution', async (role) => {
    const response = await call({ listingId: 'identity', potSlug: 'sales', capabilityRole: role });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_capability_role' });
    expect(install).not.toHaveBeenCalled();
  });

  it.each([null, [], 'not-an-object'])('refuses non-object body %j without side effects', async (body) => {
    expect((await call(body)).status).toBe(400);
    expect(install).not.toHaveBeenCalled();
  });
});
