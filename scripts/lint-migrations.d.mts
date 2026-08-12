#!/usr/bin/env node
/** Top-level transaction-control statements found in a migration file. */
export function findRawTxControl(sqlText: any): string[];
/**
 * Top-level `RENAME CONSTRAINT` statements — the 42704 footgun (WI-4547).
 *
 * `ALTER TABLE IF EXISTS t RENAME CONSTRAINT x TO y` READS as guarded and is NOT:
 * `IF EXISTS` covers the TABLE, not the CONSTRAINT. If the table exists but `x`
 * does not, Postgres still throws 42704 and aborts the whole migration.
 *
 * That is not hypothetical. Migration 592 (knowledge-packs rename) renamed five
 * constraints this way. One of them — `learning_pack_candidates_workspace_nonempty`
 * — had been destroyed long before by migration 377, which DROPPED the
 * `workspace_id` column (a CHECK constraint dies with its column). So it existed
 * on NO database, fresh or live: 592 failed deterministically EVERYWHERE, which
 * broke every fresh-DB integration test in the repo (createFreshPgDb applies the
 * full migration set) and would have failed the deploy's migration step too.
 *
 * The bug is invisible at review time precisely BECAUSE the statement looks
 * guarded, so a human check will keep missing it — hence a lint.
 *
 * The FIX SHAPE is a DO-block that renames only when the old name exists and the
 * new one does not (see 592). Because this check masks dollar-quoted bodies
 * (`maskSealingBodies`), a rename inside a `DO $$ … $$` block is invisible here and passes,
 * while a bare top-level one is caught — which is exactly the intended contract.
 * `ALTER INDEX IF EXISTS … RENAME TO` is genuinely guarded (the IF EXISTS binds
 * to the index itself) and is correctly not flagged.
 */
export function findUnguardedConstraintRename(sqlText: any): string[];
/**
 * The migration-631 class: a re-slug UPDATE that assigns a literal to
 * work_items.harness_slug WITHOUT a collision guard. On a shipped SEED that already
 * has a row at the target slug for the same feature_id, a straight UPDATE dupes
 * work_items_pkey and CRASH-LOOPS the packaged operator on first boot — the v0.0.12
 * bug that was found only AFTER a ~45-minute build (a big slice of that release's
 * 12h). Collision-safe = the file EITHER de-dups colliders first (a DELETE FROM
 * work_items) OR guards the UPDATE with NOT EXISTS; migrations 630/631 do the
 * dedup-DELETE. Returns the offending UPDATE snippet(s) ONLY when the file has a
 * reslug UPDATE and no guard (so a guarded reslug — or a file with none — is clean).
 */
export function findUnguardedReslug(sqlText: any): string[];
/**
 * Flag a LITERAL default on a tenant-scoping column — the WI-5125 class.
 *
 * Seven consolidation migrations (116/118/119/120/170) each ended with:
 *
 *     ALTER VIEW <schema>.agent_chats ALTER COLUMN workspace_id SET DEFAULT 'default'
 *
 * under a comment reading "so writers that omit these on INSERT still pass
 * through". For `harness_slug` / `created_at` that reasoning holds — the view
 * knows its own slug and `now()` is always right. For `workspace_id` it does
 * NOT: the active workspace is only knowable IN-PROCESS (a request's
 * `x-papercusp-workspace` header → ALS, or the process pin), so a literal in
 * DDL is a GUESS that is wrong for every workspace except the one hardcoded.
 *
 * The consequence is not a loud failure but a silent one: a writer omitting the
 * column INSERTs successfully under the WRONG tenant. It shipped 181/181
 * mis-tenanted agent_chats rows, and the owner met it as a work-item Chat panel
 * that spun on "loading chat…" forever (the row existed; the workspace-scoped
 * read could never see it). A loud NOT NULL violation would have been caught in
 * minutes; the literal default turned it into weeks of invisible corruption.
 *
 * Scans RAW text, deliberately UNLIKE its siblings: these ALTERs live inside the
 * per-schema `DO $$ … $$` loop that a body-sealing mask removes, so such a scan
 * would see nothing and pass — the exact false-green this lint exists to prevent.
 *
 * The FIX SHAPE is to drop the literal and let the writer stamp the column
 * explicitly (`activeWorkspaceId()`), with `fill_workspace_id_from_projects()`
 * as a derive-net. A default that DERIVES — `current_setting(...)`, a function
 * call — is fine and is not flagged; only a quoted literal is.
 */
export function findLiteralTenantDefault(sqlText: any): {
    column: string;
    value: string;
}[];
/**
 * Group migration filenames by numeric prefix; return duplicate groups whose
 * number is ≥ `enforcedFrom` (default ENFORCED_FROM). A duplicate BELOW that
 * line is pre-existing, already-applied, ledgered history — the runner keys
 * applied migrations by full FILENAME (not just the numeric prefix), so a
 * historical same-number pair with distinct names never actually collided at
 * runtime; it's a human-ambiguity smell, not a live defect, and renaming an
 * already-applied file now would break its recorded checksum. Grandfathering
 * mirrors the same enforcedFrom boundary the tx-control + reservation checks
 * already use (EI-6843: the boundary must track reality, not just intent — it
 * was stale for years while this lint went unrun, letting real duplicates
 * accumulate ungated; see ENFORCED_FROM's own history note).
 */
export function duplicateNumberGroups(filenames: any, enforcedFrom?: number): {
    num: any;
    files: any;
}[];
/**
 * The migration-461/689 class: DROPPING a table's unique index in the SAME
 * migration that creates its replacement.
 *
 * WHY THIS IS A BREAKING CHANGE, AND WHY REVIEW KEEPS MISSING IT. PostgreSQL
 * infers an `ON CONFLICT` target by MATCHING A UNIQUE INDEX. Change that index's
 * shape — add/remove a partial `WHERE` predicate, change the column set, change
 * an expression — and every `ON CONFLICT` spec written against the OLD shape
 * matches NO index and fails AT PLAN TIME. Not just on conflicting rows: EVERY
 * WRITE.
 *
 * On a SHARED database that is a deploy-ordering trap, not a code bug. The
 * migration lands the instant ANY operator boots, while the matching code lands
 * only on each operator's OWN deploy — so between those two moments every
 * not-yet-deployed reader is writing against an index that no longer exists. The
 * migration and its code fix can be authored perfectly, in one commit, and the
 * outage still happens.
 *
 * THIS TABLE HAS NOW DONE IT THREE TIMES. Migration 461 widened
 * `agent_facts_identity` from 4 columns to 5; the surviving 4-column spec errored
 * every assert and there were ZERO fact writes until it was caught on 2026-07-03.
 * Migration 564 repeated the shape on `memory_canonical` ("rebuild the identity to
 * include the source dimension" — the same authored pattern, verbatim). Migration
 * 689 then made `agent_facts_identity` PARTIAL (`WHERE superseded_at IS NULL`) and
 * dropped the old one in the same file, taking `facts:assert` down fleet-wide for
 * the whole window between the migration reaching the shared DB and the code
 * reaching the `:3070` release operator — a full hour, during which agents that
 * did not check the return value silently lost conclusions they believed durable.
 * 689's own header even DOCUMENTS this exact failure mode and still shipped it,
 * which is precisely why this needs to be mechanical rather than a review note.
 *
 * THE FIX SHAPE IS TWO-PHASE, and it is always available:
 *   migration N   — CREATE the new index, LEAVE the old one in place.
 *   (deploy the code that uses the new shape everywhere)
 *   migration N+k — DROP the old index.
 * Both shapes coexist in phase one, so old and new readers each still infer.
 *
 * SCOPE. Flags a file that creates a UNIQUE index on table T and drops SOME index
 * on T. Table-scoped on purpose: migration 506 drops an index on `spawned_agents`
 * and creates unrelated unique indexes on four other tables ~190 lines away, which
 * a naive creates-unique-and-drops rule would false-positive on. The dropped
 * index's own shape is deliberately NOT consulted — a DROP names only the index,
 * never its definition, so it is unknowable from this file; and since two-phase is
 * always possible, "dropped it in the same migration" is sufficient to flag.
 *
 * BOTH SIDES ALSO COUNT THEIR CONSTRAINT-BACKED FORM. A UNIQUE *constraint* is
 * implemented BY a unique index and is inferable by `ON CONFLICT` in exactly the
 * same way, so `ALTER TABLE t ADD CONSTRAINT c UNIQUE (...)` creates the same
 * hazard as `CREATE UNIQUE INDEX`, and `ALTER TABLE t DROP CONSTRAINT c` destroys
 * an inference target as surely as `DROP INDEX`. Matching only the INDEX spelling
 * left the check with a bypass reachable by an idiom this repo already uses 14
 * times (`ADD CONSTRAINT … UNIQUE`): the identical 689 outage authored as
 * `ALTER TABLE … DROP CONSTRAINT` + `CREATE UNIQUE INDEX … WHERE` sailed straight
 * through. A guard whose whole purpose is to be mechanical rather than a review
 * note must not have a spelling-shaped hole in it.
 *
 * A DROP CONSTRAINT is counted whatever the constraint's TYPE, so dropping a mere
 * CHECK constraint in the same migration that creates a unique index on that table
 * does flag. That is deliberate and consistent with how the INDEX side already
 * behaves: `DROP CONSTRAINT` names only the constraint, never its definition, so
 * whether it was the UNIQUE one backing somebody's `ON CONFLICT` is not knowable
 * from this file. Since two-phase is always available, the conservative reading is
 * the safe one — and the pragma is there for the author who knows better.
 *
 * A constraint action names its table in the `ALTER TABLE`, so for those drops the
 * table is matched EXACTLY and the `<table>_` name heuristic is skipped — that
 * heuristic exists only because a bare `DROP INDEX` does not say which table it
 * belonged to. Exact beats heuristic in both directions: it catches a constraint
 * whose name does not begin with its table (`uniq_facts_ident` on `agent_facts`),
 * and it will not fire on a same-named constraint dropped from a DIFFERENT table.
 *
 * ESCAPE HATCH. A swap that is genuinely safe (a brand-new table with no
 * deployed readers, an index no `ON CONFLICT` can target) may carry
 *
 *     -- lint-migrations: allow-index-swap <why it is safe>
 *
 * anywhere in the file. It requires a written reason precisely so the claim is
 * reviewable — an unexplained pragma is itself flagged.
 */
export function findUniqueIndexShapeSwap(sqlText: any): {
    index: string;
    table: string;
    partial: boolean;
    dropped: string[];
}[];
/** NNN ≥ enforcedFrom present on disk but absent from the reservations set. */
export function unreservedNumbers(fileNums: any, reservedNums: any, enforcedFrom?: number): any;
/**
 * Reservation discipline starts here. Originally 215 (2026-06 dispatch), but
 * this lint's own SCAN was never wired into an automated gate (EI-6843) — only
 * a manual `npm run lint:migrations` invoked it, which nobody ran — so real
 * violations (3 duplicate-NNN pairs, 41 raw-tx-control files, ~75 unreserved
 * numbers) accumulated PAST 215 ungated for months, all already applied and
 * ledgered (effectively frozen — editing one now is a silent no-op on every DB
 * that already ran it; see WHY APPLIED FILES ARE FROZEN below).
 * Re-baselined to the current on-disk max (2026-07-04) so this
 * boundary reflects reality: everything through 493 is grandfathered as
 * already-tolerated legacy, and enforcement is now WIRED into the automated
 * suite (lint-migrations.test.ts's "real sql/ directory" describe block, which
 * `test:affected`/the green-checkpoint gate runs on every candidate) so a
 * FUTURE violation is caught immediately instead of silently repeating this
 * exact gap. Bump this again only when deliberately re-grandfathering more
 * historical debt — never to silence a genuinely NEW violation. */
export const ENFORCED_FROM: 494;
/**
 * Enforcement boundary for the UNIQUE-INDEX SHAPE SWAP check (below).
 *
 * Deliberately its OWN boundary rather than the shared ENFORCED_FROM: three
 * already-applied files (113, 461, 564, 689) carry this pattern, and two of them
 * (564, 689) sit ABOVE ENFORCED_FROM. Applied migrations are effectively frozen
 * — editing one now would NOT re-run it on any DB that already applied it (see
 * WHY APPLIED FILES ARE FROZEN above) — so they are grandfathered and this lint
 * exists to stop the NEXT one.
 * 690 is the current max on disk; enforcement starts at the next number.
 *
 * Bump this ONLY when deliberately re-grandfathering more applied history —
 * NEVER to silence a genuinely new violation. To ship a swap that is actually
 * safe, use the documented pragma instead (see findUniqueIndexShapeSwap).
 */
export const INDEX_SWAP_ENFORCED_FROM: 691;
