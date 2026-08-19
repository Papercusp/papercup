// conversations.deliberationList/Detail — the parent-work-item harness fallback
// (conversations-agent-messages-2026-07-27 P-008/P-010).
//
// WHY THIS EXISTS. Plan decision D-005 is an owner requirement, verbatim: "the
// attached to things should actually link to the thing." P-010 shipped the ref
// pills and 74/74 UI unit tests passed — but driving the real Tauri shell showed
// every "ATTACHED TO" pill opening WorkItemPopupModal's dead end, "No harness
// context for WI-6355."
//
// The cause was upstream of the pills: `coord_threads.harness_slug` is null for
// 5,698 of 5,761 threads (98.9%), and both the popup and HydratedWorkRefPill
// need a harness to scope `workItems.detail`. So the pane passed null, honestly,
// and the feature was 100% dead on the Decisions source.
//
// The harness was recoverable all along — from the work-item the thread hangs
// off (`parent_ref`). That fixes 5,115 of the 5,698 (89.7%); the remaining 583
// have no resolvable parent and correctly keep the "no harness context" state
// rather than guessing across harnesses.
//
// This is also why the fallback must NOT be "inherit the conversation's
// harness": the very first row that failed, issue-thread-WI-6355, hangs off a
// work-item in `oddsmith-hive` while the pane rendered it under papercusp.
// Inheriting would have produced a confident lookup in the WRONG harness — a
// silent "No item found" instead of a correct link.

import { describe, expect, it, vi } from 'vitest';

/** Captures the SQL text each tagged-template call emits. */
const emitted: string[] = [];
const sql = Object.assign(
  (strings: TemplateStringsArray, ..._v: unknown[]) => {
    emitted.push(strings.join('?'));
    return Promise.resolve([]);
  },
  { unsafe: () => Promise.resolve([]) },
);

// FULL-REPLACEMENT MOCK HAZARD (WI-39843 class): a bare factory replaces the WHOLE
// module, so any export this file's import graph reaches but does not re-declare becomes
// undefined and vitest throws on access — here `setAdminPoolStatementTimeoutProvider`.
// Spread the original so only `getOrgPg` is overridden and a future export cannot strand it.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));

/** Normalise whitespace so the assertions read on intent, not formatting. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('deliberation harness fallback', () => {
  it('resolves harness from the parent work-item, not from the thread alone', async () => {
    emitted.length = 0;
    const { resolveNamedQueryV2 } = await import('./index');
    await resolveNamedQueryV2('conversations.deliberationList', { limit: 10 });

    const listSql = emitted.map(flat).find((s) => s.includes('coord_threads'));
    expect(listSql, 'deliberationList should query coord_threads').toBeTruthy();

    // The fallback itself: COALESCE onto a work_items lookup keyed by parent_ref.
    expect(listSql).toContain('COALESCE');
    expect(listSql).toContain('harness_shared.work_items');
    expect(listSql).toContain('feature_id = t.parent_ref');

    // LIMIT 1 is load-bearing, not decoration: `feature_id` is NOT unique across
    // harnesses for F-NNN ids, so a plain JOIN would MULTIPLY thread rows and
    // silently inflate the pane's list. Keep it a scalar subquery.
    expect(flat(listSql!)).toMatch(/work_items w[\s\S]*?LIMIT 1/);
  });

  it('keeps a thread\'s OWN harness when it has one (fallback is second, not first)', async () => {
    emitted.length = 0;
    const { resolveNamedQueryV2 } = await import('./index');
    await resolveNamedQueryV2('conversations.deliberationList', { limit: 10 });

    const listSql = flat(emitted.find((s) => s.includes('coord_threads')) ?? '');
    // t.harness_slug must be the FIRST COALESCE argument — the thread's own
    // value is authoritative where present; the parent is only a recovery.
    expect(listSql).toMatch(/COALESCE\(\s*t\.harness_slug/);
  });

  it('applies the same fallback on the detail read, so the popup and the row agree', async () => {
    emitted.length = 0;
    const { resolveNamedQueryV2 } = await import('./index');
    await resolveNamedQueryV2('conversations.deliberationDetail', { id: 'issue-thread-WI-6355' });

    const threadSql = emitted.map(flat).find((s) => s.includes('coord_threads'));
    expect(threadSql, 'deliberationDetail should query coord_threads').toBeTruthy();
    // A list that resolves the harness while the detail does not is the worst
    // outcome: the pill looks live in the list and dies when opened.
    expect(threadSql).toContain('harness_shared.work_items');
    expect(threadSql).toContain('feature_id = t.parent_ref');
  });
});
