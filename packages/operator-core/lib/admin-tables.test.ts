/**
 * Coverage for admin-tables — the editable-table allowlist registry.
 * First-party tables are auto-registered at import; tests assert lookup, the
 * label-sorted listing, registration, and that an unlisted table is refused
 * (null) — the allowlist guard.
 */
import { describe, expect, it } from 'vitest';
import { registerAdminTable, getAdminTable, listAdminTables } from './admin-tables';

describe('admin-tables registry', () => {
  it('auto-registers the first-party tables with their editable columns', () => {
    const settings = getAdminTable('operatorSettingsInHarnessShared');
    expect(settings?.label).toBe('Papercup settings');
    expect(settings?.editableColumns).toContain('key');
    expect(getAdminTable('operatorBudgetTiersInHarnessShared')?.label).toBe('Papercup budget tiers');
  });

  it('refuses an unlisted table (allowlist guard)', () => {
    expect(getAdminTable('token_index')).toBeNull();
    expect(getAdminTable('definitely_not_registered')).toBeNull();
  });

  it('listAdminTables is sorted by label', () => {
    const labels = listAdminTables().map((t) => t.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(labels.length).toBeGreaterThanOrEqual(3);
  });

  it('registerAdminTable adds a retrievable entry', () => {
    const existing = getAdminTable('operatorSettingsInHarnessShared')!;
    registerAdminTable({ exportName: 'pluginOwnedTbl_test', table: existing.table, label: 'Plugin Owned (test)' });
    expect(getAdminTable('pluginOwnedTbl_test')?.label).toBe('Plugin Owned (test)');
  });
});
