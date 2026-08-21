/**
 * validate-repoint-triggers — the boot-time visibility guard for EI-19389225060317498.
 *
 * Proves: a disabled or missing coupled trigger (repoint_qualified_refs_trg /
 * wir_deps_sync_trg) is WARNED loudly (naming which one and the readiness-sidecar
 * consequence); both enabled logs quietly; and a DB read failure never fails the check
 * (fail-soft, like every startup/ sibling).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<{ table_name: string; trigger_name: string; enabled: string }>,
  throwOnQuery: false,
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: async () => {
      if (h.throwOnQuery) throw new Error('connection refused');
      return h.rows;
    },
  }),
}));

const { checkRepointTriggersEnabled, REPOINT_COUPLED_TRIGGERS } = await import('./validate-repoint-triggers');

beforeEach(() => {
  h.rows = [];
  h.throwOnQuery = false;
});

describe('checkRepointTriggersEnabled', () => {
  it('logs quietly (no warn) when both coupled triggers are enabled', async () => {
    h.rows = [
      { table_name: 'work_items', trigger_name: 'repoint_qualified_refs_trg', enabled: 'O' },
      { table_name: 'work_item_deps', trigger_name: 'wir_deps_sync_trg', enabled: 'O' },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const r = await checkRepointTriggersEnabled();

    expect(r.ok).toBe(true);
    expect(r.couplingBroken).toBe(false);
    expect(r.missing).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it('WARNS when wir_deps_sync_trg is disabled even though repoint_qualified_refs_trg is enabled — ' +
    'the exact class 734\'s own warning misses', async () => {
    h.rows = [
      { table_name: 'work_items', trigger_name: 'repoint_qualified_refs_trg', enabled: 'O' },
      { table_name: 'work_item_deps', trigger_name: 'wir_deps_sync_trg', enabled: 'D' },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await checkRepointTriggersEnabled();

    expect(r.ok).toBe(true);
    expect(r.couplingBroken).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('wir_deps_sync_trg on work_item_deps is DISABLED'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EI-19389225060317498'));
    warn.mockRestore();
  });

  it('WARNS when repoint_qualified_refs_trg is disabled (the case 734\'s warning DOES cover)', async () => {
    h.rows = [
      { table_name: 'work_items', trigger_name: 'repoint_qualified_refs_trg', enabled: 'D' },
      { table_name: 'work_item_deps', trigger_name: 'wir_deps_sync_trg', enabled: 'O' },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await checkRepointTriggersEnabled();

    expect(r.couplingBroken).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('repoint_qualified_refs_trg on work_items is DISABLED'),
    );
    warn.mockRestore();
  });

  it('WARNS when a coupled trigger is missing from the catalog entirely (dropped, not just disabled)', async () => {
    h.rows = [{ table_name: 'work_items', trigger_name: 'repoint_qualified_refs_trg', enabled: 'O' }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await checkRepointTriggersEnabled();

    expect(r.couplingBroken).toBe(true);
    expect(r.missing).toEqual(['wir_deps_sync_trg']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wir_deps_sync_trg is MISSING'));
    warn.mockRestore();
  });

  it('exports exactly the two coupled trigger names this incident is about', () => {
    expect(REPOINT_COUPLED_TRIGGERS).toEqual(['repoint_qualified_refs_trg', 'wir_deps_sync_trg']);
  });

  it('fail-soft: a DB read failure never throws and reports no breakage', async () => {
    h.throwOnQuery = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await checkRepointTriggersEnabled();

    expect(r.ok).toBe(true);
    expect(r.triggers).toEqual([]);
    expect(r.couplingBroken).toBe(false);
    warn.mockRestore();
  });
});
