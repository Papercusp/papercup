/**
 * Coverage for harness-prompt-overrides: the (workspace, harness, role) prompt
 * override CRUD. The org-PG `sql` tagged template is mocked (postgres-js style),
 * so the tests assert null-defaulting, RETURNING→boolean/count mapping, and the
 * snake→camel + Number row mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql }) };
});

type Mod = typeof import('./harness-prompt-overrides');
async function load(): Promise<Mod> {
  return import('./harness-prompt-overrides');
}

beforeEach(() => {
  vi.resetModules();
  sql.mockReset();
  sql.mockResolvedValue([]);
});

describe('getPromptOverride', () => {
  it('returns the prompt markdown when a row exists', async () => {
    sql.mockResolvedValueOnce([{ prompt_md: '# worker override' }]);
    expect(await (await load()).getPromptOverride('ws', 'h', 'worker')).toBe('# worker override');
  });
  it('returns null when unset', async () => {
    sql.mockResolvedValueOnce([]);
    expect(await (await load()).getPromptOverride('ws', 'h', 'worker')).toBeNull();
  });
  it('ensures the table on first use (sql.unsafe)', async () => {
    await (await load()).getPromptOverride('ws', 'h', 'worker');
    expect(sqlUnsafe).toHaveBeenCalledOnce();
  });
});

describe('setPromptOverride', () => {
  it('upserts with the (ws, harness, role, md) values', async () => {
    await (await load()).setPromptOverride('ws', 'h', 'worker', '# md');
    // The tagged sql is called once for the INSERT; values follow the strings array.
    const values = (sql.mock.calls[0] as unknown as unknown[]).slice(1);
    expect(values.slice(0, 4)).toEqual(['ws', 'h', 'worker', '# md']);
    expect(typeof values[4]).toBe('number'); // updated_at = Date.now()
  });
});

describe('deletePromptOverride', () => {
  it('returns true when a row was deleted', async () => {
    sql.mockResolvedValueOnce([{ role: 'worker' }]);
    expect(await (await load()).deletePromptOverride('ws', 'h', 'worker')).toBe(true);
  });
  it('returns false when nothing matched', async () => {
    sql.mockResolvedValueOnce([]);
    expect(await (await load()).deletePromptOverride('ws', 'h', 'worker')).toBe(false);
  });
});

describe('clearAllPromptOverrides', () => {
  it('returns the count of removed rows', async () => {
    sql.mockResolvedValueOnce([{ role: 'a' }, { role: 'b' }, { role: 'c' }]);
    expect(await (await load()).clearAllPromptOverrides('ws', 'h')).toBe(3);
  });
});

describe('listPromptOverrides', () => {
  it('maps snake_case rows to camelCase with a numeric updatedAt', async () => {
    sql.mockResolvedValueOnce([
      { role: 'worker', prompt_md: 'p1', updated_at: '1700' },
      { role: 'scoper', prompt_md: 'p2', updated_at: '1800' },
    ]);
    expect(await (await load()).listPromptOverrides('ws', 'h')).toEqual([
      { role: 'worker', promptMd: 'p1', updatedAt: 1700 },
      { role: 'scoper', promptMd: 'p2', updatedAt: 1800 },
    ]);
  });
});
