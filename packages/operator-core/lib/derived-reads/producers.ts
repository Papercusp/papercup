/**
 * The registered derived-read producers — the three measured offenders from the
 * WI-5460 audit (precompute-derived-sync-reads-2026-07-19 P-003/P-004/P-005).
 *
 * Each one moves an expensive computation OFF the user-facing sync read path and
 * onto the `system:precompute-derived-reads` routine. The resolver then does a
 * plain SELECT against `harness_shared.derived_read_snapshots`.
 *
 * Imported for side effect by the routine action and by the sync resolver, so a
 * read and a refresh always agree on which producers exist.
 *
 * TTLs are chosen from how fast the underlying signal actually moves, NOT from
 * how expensive the compute is — an expensive producer with a short ttl is the
 * routine's problem to schedule, never the reader's problem to wait for.
 */
import { registerDerivedRead } from './registry';

// ── storage.usage (P-003) — measured 20.0s on the read path ──────────────────
//
// A recursive du-style disk walk plus PG catalog sizing. The pre-fix code ran it
// inline and mitigated the pain with a wall-clock budget (DISK_BUDGET_MS,
// EI-6045) that returned PARTIAL sizes with an apologetic note — a mitigation
// that existed only because the walk was on the read path. Precomputed, the walk
// can run to completion and report accurate sizes.
//
// Disk usage moves slowly; a 30-minute snapshot is far fresher than a Settings
// page needs.
registerDerivedRead({
  key: 'storage.usage',
  ttlMs: 30 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { computeStorageUsage } = await import('../storage/usage');
    // `offReadPath` raises the disk-walk budget: nobody is waiting on this, so
    // the walk can finish and report complete sizes instead of the partial ones
    // the 20s read-path budget produced on a large store.
    return computeStorageUsage({ offReadPath: true });
  },
});

// ── plans.lint (P-004) — measured 13.8s on the read path ─────────────────────
//
// Lints the entire plan corpus. The corpus changes on plan writes, which are
// frequent but not per-page-load; 10 minutes keeps the lint feed useful without
// re-parsing every plan for each viewer.
registerDerivedRead({
  key: 'plans.lint',
  ttlMs: 10 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
    const r = (await callPlansRead('lint', {})) as { reports?: unknown[] };
    return Array.isArray(r?.reports) ? r.reports : [];
  },
});

// ── learning.soakReport (P-005) — measured 27.3s on the read path ────────────
//
// The worst offender: a host-global `journalctl` scan that sat INSIDE a per-pot
// fan-out, so ~12 hives meant ~24 concurrent scans of a 1.2GB journal per
// Learnings-tab load, all returning byte-identical results.
//
// Precompute replaces the getOrSet cache landed earlier in WI-5460, which was
// always a stopgap: a cache still pays the full 27s on cold load, and on a host
// with no journald it fails rather than degrades (see the P-005 capability
// detection in pot/soak-report.ts).
//
// The rolling window is 12–24h, so the report barely moves minute to minute;
// 10 minutes is comfortably fresh for a readiness panel.
registerDerivedRead({
  key: 'learning.soakReport',
  ttlMs: 10 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async ({ workspaceId }) => {
    const { listPots } = await import('../agent-tools/pot/_resolve');
    const { readPotSoakReport } = await import('../pot/soak-report');
    const homes = await listPots(workspaceId).catch(() => []);
    const reports = (
      await Promise.all(
        homes.map(async (home: { slug: string }) => {
          try {
            return await readPotSoakReport(home.slug, {});
          } catch {
            return null;
          }
        }),
      )
    ).filter((report): report is NonNullable<typeof report> => report != null);
    return [{ hives: reports }];
  },
});
