/**
 * §15.5 step 4 — registry of `harness_shared.*` tables and how to filter
 * each one to **just this harness's rows** at capture time.
 *
 * Without this, snapshots would either silently omit shared rows (bug) or
 * include all of harness_shared globally (cross-harness leak — the spec's
 * primary correctness concern).
 *
 * **Adding a new shared table:** the CI check at §15.22 fails any new
 * `CREATE TABLE harness_shared.X` in libs/papercusp/libs/db/sql/*.sql
 * without a corresponding entry below. Forces the leak-prevention
 * conversation at PR time, not at incident time.
 *
 * **Restore-side ID rewriting:** at restore time, the snapshot's row IDs
 * for `id_pk = true` tables get prefixed with the fork-slug suffix to
 * avoid the silent-corruption case where the same logical project (e.g.
 * `PROJ-XYZ`) exists on both publisher's and consumer's machines with
 * divergent local PM curation. See §15.6 step 7e.
 */

export interface SharedTableFilter {
  /** Table name within harness_shared. */
  table: string;
  /**
   * SQL WHERE-clause fragment, given the harness slug. Substrate templates
   * in the slug as a single-quoted SQL literal — slugs are validated
   * `^[a-z0-9][a-z0-9._-]{0,63}$` so injection isn't possible, but treat
   * defensively anyway.
   */
  filter: (slug: string) => string;
  /**
   * If true, the row's primary-key column (`id`) is rewritten with the
   * fork-slug suffix at restore time, and FK references in the per-harness
   * schema get updated in the same transaction. See §15.6 step 7e.
   */
  forkPrefixIds?: boolean;
  /**
   * Foreign-key columns in *per-harness* tables that reference this table's
   * `id`. May be explicitly empty for forkPrefixIds tables nothing in the
   * per-harness schema references (the empty list is the audit record).
   */
  fkRefsInPerHarness?: { table: string; column: string }[];
  /**
   * Column holding the captured harness slug. At restore time every row
   * whose value equals the snapshot's original slug is rewritten to the
   * fork slug — without this, restored rows stay keyed to the publisher's
   * slug: orphaned on a cross-machine fork, or silently BLED INTO the
   * source harness on a local fork (the §15.6 step-7e corruption class,
   * slug edition).
   */
  slugColumn?: string;
  /**
   * Table-specific row shaping at restore, applied after the slugColumn
   * rewrite and before forkPrefixIds. For transforms the declarative knobs
   * can't express (e.g. work_items' issue-family id suffixing).
   */
  restoreRowTransform?: (
    row: Record<string, unknown>,
    ctx: { originalSlug: string; newSlug: string; forkSuffix: string },
  ) => Record<string, unknown>;
  /**
   * Either INCLUDE-with-filter (default) or EXCLUDE entirely.
   * Trigger-maintained mirrors are excluded on capture; they get rebuilt
   * automatically when per-harness data lands on restore.
   */
  mode: 'include' | 'exclude';
  /** Reason rendered in audit logs and snapshot manifest's `excluded[]`. */
  reason?: string;
}

const ENABLED_FEATURES_PROJECT_IDS = (slug: string) =>
  `id IN (SELECT DISTINCT project_id
            FROM harness_${slug}.harness_features
           WHERE project_id IS NOT NULL)`;

/**
 * Identity / membership / trust / credentials tables — NEVER captured into a
 * portable snapshot. Per RFC `project-centric-harness-rethink-2026-06-04` D-011
 * (folded into distribution D-011): who-can-collaborate — members, per-user
 * identity, device pubkeys, GitHub bindings, trust grants — is PG + peer-log
 * canonical, NOT portable per-harness state. The credential/secret tables are
 * excluded for that reason *and* the obvious security one: a snapshot handed to
 * a forker (or published to the Cupboard) must never carry operator secrets.
 *
 * All live in `harness_shared` and were already outside the capture set (they
 * are simply absent from the include list, and the per-harness `harness_<slug>`
 * dump doesn't reach them). These explicit `exclude` entries make the omission
 * INTENTIONAL: they surface the tables in the manifest's `excluded[]` with a
 * cited reason, and `shared-table-filters.test.ts` guards against any future
 * change silently moving one into capture.
 */
export const IDENTITY_TRUST_TABLES = [
  'contributors',
  'contributor_usage_events',
  'identity_files',
  'mobile_devices',
  'mobile_pair_tokens',
  'oauth_nonces',
  'operator_credentials',
  'operator_publish_credentials',
  'operator_search_provider_credentials',
  'operator_trust_store',
  'operator_voice_credentials',
  'trusted_authors',
] as const;

export const SHARED_TABLE_FILTERS: SharedTableFilter[] = [
  {
    table: 'projects',
    mode: 'include',
    filter: ENABLED_FEATURES_PROJECT_IDS,
    forkPrefixIds: true,
    fkRefsInPerHarness: [{ table: 'harness_features', column: 'project_id' }],
  },
  {
    table: 'project_spec_revisions',
    mode: 'include',
    filter: (slug) =>
      `project_id IN (SELECT id FROM harness_shared.projects WHERE ${ENABLED_FEATURES_PROJECT_IDS(
        slug,
      )})`,
    // FK is to projects.id; rewriting projects.id at restore cascades via
    // a separate UPDATE of project_spec_revisions.project_id (see restore.ts).
  },
  {
    table: 'pending_events',
    mode: 'include',
    filter: (slug) => `install_slug = '${slug}'`,
    slugColumn: 'install_slug',
    // PK is the bare `id` (workspace-global): a LOCAL fork re-inserts the
    // exact captured ids → PK collision → whole restore tx rolls back.
    // Nothing per-harness references the id, hence the explicit empty list.
    forkPrefixIds: true,
    fkRefsInPerHarness: [],
  },
  {
    table: 'routines',
    mode: 'include',
    filter: (slug) => `install_slug = '${slug}'`,
    slugColumn: 'install_slug',
    forkPrefixIds: true, // same bare-`id` PK as pending_events
    fkRefsInPerHarness: [],
  },
  {
    table: 'goals',
    mode: 'include',
    filter: (slug) => `install_slug = '${slug}'`,
    slugColumn: 'install_slug',
    forkPrefixIds: true,
    fkRefsInPerHarness: [{ table: 'harness_features', column: 'goal_id' }],
  },
  {
    table: 'harness_features_consolidated',
    mode: 'exclude',
    filter: () => 'FALSE',
    reason: 'trigger-maintained mirror; rebuilt from per-harness rows on restore',
  },
  {
    table: 'audit_log',
    mode: 'exclude',
    filter: () => 'FALSE',
    reason: 'cross-harness audit log; not slug-scoped, capturing would leak other harnesses',
  },
  ...IDENTITY_TRUST_TABLES.map(
    (table): SharedTableFilter => ({
      table,
      mode: 'exclude',
      filter: () => 'FALSE',
      reason:
        'identity/membership/trust/credentials — PG+peer-log-canonical, never portable per-harness state (RFC project-centric-harness-rethink-2026-06-04 D-011); credential tables are additionally a hard security exclusion',
    }),
  ),
  {
    table: 'snapshot_index',
    mode: 'exclude',
    filter: () => 'FALSE',
    reason:
      'operator-local discovery index for portable export-state snapshots (hybrid FS+PG home — distribution P-006/D-010); not portable per-harness state',
  },
  {
    // work_items is the cross-kind UNION view (mig 159, unify-work-items
    // D-010=(b)): harness_features_consolidated (feature|research-task|chunk)
    // ∪ engineer_issues (bug|change|task) in the feature column space, with
    // INSTEAD OF triggers routing writes by item_kind. Capture ONLY the
    // NON-feature work-items: feature-kind rows ride the per-harness
    // capture+rebuild path (harness_features_consolidated is an `exclude`),
    // so a blanket include would duplicate them. The to_regclass guard in
    // pg-dump.ts copyFilteredSharedTables makes this safe if the view is
    // absent. (su-4b6ce P-005 spec, 2026-06-04; distribution P-005.)
    //
    // Restore (the P-005 follow-on, built 2026-06-05 — distribution item 3):
    //   • slugColumn rewrites harness_slug → the fork slug; the INSTEAD OF
    //     trigger then derives scope 'harness:<newSlug>' for issue-family rows
    //     and the fresh (harness_slug, feature_id) PK for hfc-family rows.
    //   • Issue-family ids (bug|change|task → engineer_issues, PK
    //     (workspace_id, issue_id) — workspace-GLOBAL) get the `_fork_<suffix>`
    //     suffix, same precedent as projects.forkPrefixIds, to avoid colliding
    //     with the consumer's own WI-NNN sequence. hfc-family ids stay intact
    //     (slug-scoped PK; preserves intra-fork F-NNN/WI-NNN references).
    //   Known limit: WI-NNN cross-references inside `payload` JSON are NOT
    //   rewritten (same posture as slug-rewrite.ts's structured-contexts-only
    //   rule — better a stale ref than a corrupted payload).
    table: 'work_items',
    mode: 'include',
    filter: (slug) => `harness_slug = '${slug}' AND item_kind <> 'feature'`,
    slugColumn: 'harness_slug',
    restoreRowTransform: (row, { forkSuffix }) =>
      ISSUE_FAMILY_KINDS.has(String(row.item_kind))
        ? { ...row, feature_id: `${String(row.feature_id)}_fork_${forkSuffix}` }
        : row,
  },
];

/**
 * The issue-family discriminators — rows the work_items view routes to
 * engineer_issues (mig 159's trigger). Must stay in lockstep with
 * harness_shared.work_items_view_dml.
 */
export const ISSUE_FAMILY_KINDS: ReadonlySet<string> = new Set(['bug', 'change', 'task']);

export function findSharedTableFilter(table: string): SharedTableFilter | undefined {
  return SHARED_TABLE_FILTERS.find((f) => f.table === table);
}

export function includedSharedTables(): SharedTableFilter[] {
  return SHARED_TABLE_FILTERS.filter((f) => f.mode === 'include');
}

export function excludedSharedTables(): SharedTableFilter[] {
  return SHARED_TABLE_FILTERS.filter((f) => f.mode === 'exclude');
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid harness slug: ${JSON.stringify(slug)}`);
  }
}
