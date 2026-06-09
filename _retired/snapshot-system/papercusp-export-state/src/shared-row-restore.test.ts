import { describe, expect, it } from 'vitest';
import { transformSharedRows } from './shared-row-restore';
import { ISSUE_FAMILY_KINDS, findSharedTableFilter } from './shared-table-filters';
import type { SharedTableFilter } from './shared-table-filters';

const CTX = { originalSlug: 'sheets', newSlug: 'sheets_fork_ab12', forkSuffix: 'ab12' };

describe('transformSharedRows', () => {
  it('rewrites the slugColumn from the original slug to the fork slug', () => {
    const reg: SharedTableFilter = {
      table: 't',
      mode: 'include',
      filter: () => 'TRUE',
      slugColumn: 'install_slug',
    };
    const out = transformSharedRows(reg, [{ id: 'r1', install_slug: 'sheets' }], CTX);
    expect(out).toEqual([{ id: 'r1', install_slug: 'sheets_fork_ab12' }]);
  });

  it('leaves rows whose slug does not match the original untouched (incl. NULL)', () => {
    const reg: SharedTableFilter = {
      table: 't',
      mode: 'include',
      filter: () => 'TRUE',
      slugColumn: 'install_slug',
    };
    const rows = [
      { id: 'r1', install_slug: 'other-harness' },
      { id: 'r2', install_slug: null },
    ];
    expect(transformSharedRows(reg, rows, CTX)).toEqual(rows);
  });

  it('applies forkPrefixIds after the slug rewrite', () => {
    const reg: SharedTableFilter = {
      table: 't',
      mode: 'include',
      filter: () => 'TRUE',
      slugColumn: 'install_slug',
      forkPrefixIds: true,
      fkRefsInPerHarness: [],
    };
    const out = transformSharedRows(reg, [{ id: 'r1', install_slug: 'sheets' }], CTX);
    expect(out).toEqual([{ id: 'r1_fork_ab12', install_slug: 'sheets_fork_ab12' }]);
  });

  it('passes rows through unchanged when no transform knobs are set', () => {
    const reg: SharedTableFilter = { table: 't', mode: 'include', filter: () => 'TRUE' };
    const rows = [{ id: 'r1', anything: 'x' }];
    expect(transformSharedRows(reg, rows, CTX)).toEqual(rows);
  });

  describe('work_items registry entry (the live config)', () => {
    const reg = findSharedTableFilter('work_items')!;

    it('re-keys harness_slug and suffixes ONLY issue-family ids', () => {
      const rows = [
        // issue-family (engineer_issues, workspace-global PK) → id suffixed
        { feature_id: 'WI-7', item_kind: 'task', harness_slug: 'sheets' },
        { feature_id: 'WI-9', item_kind: 'bug', harness_slug: 'sheets' },
        { feature_id: 'WI-12', item_kind: 'change', harness_slug: 'sheets' },
        // hfc-family (slug-scoped PK) → id kept, slug re-keyed
        { feature_id: 'WI-3', item_kind: 'research-task', harness_slug: 'sheets' },
        { feature_id: 'F-021', item_kind: 'chunk', harness_slug: 'sheets' },
      ];
      const out = transformSharedRows(reg, rows, CTX);
      expect(out).toEqual([
        { feature_id: 'WI-7_fork_ab12', item_kind: 'task', harness_slug: 'sheets_fork_ab12' },
        { feature_id: 'WI-9_fork_ab12', item_kind: 'bug', harness_slug: 'sheets_fork_ab12' },
        { feature_id: 'WI-12_fork_ab12', item_kind: 'change', harness_slug: 'sheets_fork_ab12' },
        { feature_id: 'WI-3', item_kind: 'research-task', harness_slug: 'sheets_fork_ab12' },
        { feature_id: 'F-021', item_kind: 'chunk', harness_slug: 'sheets_fork_ab12' },
      ]);
    });

    it('never mutates the input rows', () => {
      const row = { feature_id: 'WI-7', item_kind: 'task', harness_slug: 'sheets' };
      transformSharedRows(reg, [row], CTX);
      expect(row).toEqual({ feature_id: 'WI-7', item_kind: 'task', harness_slug: 'sheets' });
    });
  });

  it('ISSUE_FAMILY_KINDS matches mig 159 work_items_view_dml routing exactly', () => {
    expect([...ISSUE_FAMILY_KINDS].sort()).toEqual(['bug', 'change', 'task']);
  });
});
