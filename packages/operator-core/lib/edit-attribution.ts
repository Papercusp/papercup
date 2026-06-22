/**
 * edit-attribution — the P-001 edit-time CAPTURE of
 * deterministic-commit-workitem-attribution-2026-06-22.
 *
 * Writes one harness_shared.edit_attribution_ledger row per granted file edit, joining
 * the lock holder's claimed lane (work-item + harness) AT EDIT TIME (D-002) so attribution
 * SURVIVES the agent's session ending before the ~10-min git-sync tick. git-sync reads this
 * window back by repo_root+file to attribute its per-agent commits (P-003), and the durable
 * git_sync_commit_attribution link (P-004) feeds the doc-drift (P-005) + merge-resolver
 * (P-006) consumers.
 *
 * DETERMINISTIC + best-effort (D-001/D-006): pure server code — NO LLM, NO extra agent tool
 * call (the work-item is read from the claim the agent ALREADY holds). Called fire-and-forget
 * from the locks:acquire grant; ANY failure here is swallowed and must NEVER affect the lock
 * (the hot per-edit path). Mirrors the best-effort raw-SQL pattern of lib/decision-ledger/emit.ts.
 */

import { getOrgPg } from '@papercusp/db-org';
import { getActiveClaimForOwner } from './work-item-claims';

export interface RecordEditAttributionInput {
  /** The lock's coordination domain — the physical repo root (the join key). */
  repoRoot: string;
  /** Superproject-relative paths the lock was granted over. */
  files: string[];
  /** The lock holder's stable owner id. */
  agentId: string;
  /** The lock's per-edit intent. */
  intent?: string;
  /** The editing agent's workspace — required to look up its claimed lane. */
  workspaceId?: string;
  sessionId?: string;
  contributor?: string;
}

/**
 * Append edit-attribution ledger rows for a just-granted lock. Resolves the holder's
 * work-item from its active claim (one cheap indexed read) and writes one row per file.
 * Never throws.
 */
export async function recordEditAttribution(input: RecordEditAttributionInput): Promise<void> {
  try {
    const files = (input.files ?? []).filter(Boolean);
    if (files.length === 0 || !input.agentId || !input.repoRoot) return;

    // The work-item join, at edit time (D-002). One cheap single-row claim read; NULL when
    // the agent holds no live claim → an honest unattributed edit (D-003), never a guess.
    let harnessSlug: string | null = null;
    let workItemId: string | null = null;
    if (input.workspaceId) {
      const claim = await getActiveClaimForOwner(input.workspaceId, input.agentId).catch(() => null);
      if (claim) {
        harnessSlug = claim.harnessSlug ?? null;
        workItemId = claim.workItemId ?? null;
      }
    }

    const { sql } = getOrgPg();
    // One row per file via unnest — a single round-trip on the hot path.
    await sql`
      INSERT INTO harness_shared.edit_attribution_ledger
        (repo_root, file, agent_id, session_id, contributor, workspace_id,
         harness_slug, work_item_id, plan_slug, intent)
      SELECT ${input.repoRoot}, f, ${input.agentId}, ${input.sessionId ?? null},
             ${input.contributor ?? null}, ${input.workspaceId ?? null},
             ${harnessSlug}, ${workItemId}, ${null}, ${input.intent ?? null}
        FROM unnest(${files}::text[]) AS f
    `;
  } catch {
    // best-effort: edit attribution must NEVER break the lock path.
  }
}

/** One agent's attributed edits in a repo, as git-sync reads them back (P-003). Shaped to
 *  AttributionRosterEntry (git-sync-attribution.ts) — superproject-relative `files`. */
export interface LedgerRosterEntry {
  agent: string;
  files: string[];
  workItems: string[];
  planSlug?: string;
  intent?: string;
  sessionId?: string;
  contributor?: string;
}

interface LedgerRow {
  agent_id: string;
  file: string;
  work_item_id: string | null;
  plan_slug: string | null;
  intent: string | null;
  session_id: string | null;
  contributor: string | null;
}

/**
 * Build git-sync's attribution roster for a repo from the edit ledger (P-003) — the
 * DURABLE source (D-002), so a commit is attributed even after the editing agent's session
 * ended (which live-presence derivation misses). Each file is attributed to its MOST-RECENT
 * editor within `lookbackHours` (DISTINCT ON (file) ORDER BY ts DESC — index-backed on
 * (repo_root, file, ts DESC)); rows are then grouped by agent. Best-effort: returns [] on
 * any error so the caller falls back to presence. `repoRoot` is the lock coordination
 * domain (the physical repo root the ledger keys on).
 */
export async function readEditAttributionRoster(
  repoRoot: string,
  lookbackHours = 24,
): Promise<LedgerRosterEntry[]> {
  try {
    if (!repoRoot) return [];
    const { sql } = getOrgPg();
    const rows = await sql<LedgerRow[]>`
      SELECT DISTINCT ON (file)
             agent_id, file, work_item_id, plan_slug, intent, session_id, contributor
        FROM harness_shared.edit_attribution_ledger
       WHERE repo_root = ${repoRoot}
         AND ts >= now() - make_interval(hours => ${lookbackHours})
       ORDER BY file, ts DESC
    `;
    const byAgent = new Map<string, LedgerRosterEntry>();
    for (const r of rows) {
      let e = byAgent.get(r.agent_id);
      if (!e) {
        e = { agent: r.agent_id, files: [], workItems: [] };
        byAgent.set(r.agent_id, e);
      }
      if (!e.files.includes(r.file)) e.files.push(r.file);
      if (r.work_item_id && !e.workItems.includes(r.work_item_id)) e.workItems.push(r.work_item_id);
      // DISTINCT ON gave the latest row per file; keep the first non-null scalar we see.
      if (r.plan_slug && !e.planSlug) e.planSlug = r.plan_slug;
      if (r.intent && !e.intent) e.intent = r.intent;
      if (r.session_id && !e.sessionId) e.sessionId = r.session_id;
      if (r.contributor && !e.contributor) e.contributor = r.contributor;
    }
    return [...byAgent.values()];
  } catch {
    return [];
  }
}

/** The Papercusp provenance a git-sync per-agent commit carries in its trailers (P-004). */
export interface ParsedCommitAttribution {
  agent?: string;
  workItems: string[];
  sessionId?: string;
  planSlug?: string;
}

/**
 * Parse the `Papercusp-Agent|Work-Item|Session|Plan:` trailers a git-sync per-agent commit
 * carries (written in run-git-sync.ts). Pure + testable. The commit↔work-item link travels in
 * git history via these; the post-sync reader (P-004) turns them + the commit's changed files
 * into git_sync_commit_attribution rows for the fast reverse-index the consumers query.
 */
export function parsePapercuspTrailers(commitBody: string): ParsedCommitAttribution {
  const out: ParsedCommitAttribution = { workItems: [] };
  for (const raw of (commitBody ?? '').split('\n')) {
    const m = /^(Papercusp-Agent|Papercusp-Work-Item|Papercusp-Session|Papercusp-Plan):\s*(.+)$/.exec(raw.trim());
    if (!m) continue;
    const val = m[2].trim();
    if (m[1] === 'Papercusp-Agent') out.agent = val;
    else if (m[1] === 'Papercusp-Work-Item') out.workItems = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'Papercusp-Session') out.sessionId = val;
    else if (m[1] === 'Papercusp-Plan') out.planSlug = val;
  }
  return out;
}

/** One git_sync_commit_attribution row — the durable commit→work-item link (P-004). */
export interface CommitAttributionRow {
  workspaceId: string;
  harnessSlug: string;
  /** scope: 'superproject' or a submodule path. */
  repo: string;
  commitSha: string;
  file: string;
  agentId?: string;
  sessionId?: string;
  workItemId?: string;
  planSlug?: string;
}

/**
 * Bulk-insert git_sync_commit_attribution rows (P-004) — one per (file × work-item) for a
 * git-sync commit. DETERMINISTIC + best-effort (D-006): raw SQL, never throws. Powers the
 * doc-drift "which work-item changed this code?" join (P-005) + the merge-resolver authorship
 * context (P-006).
 */
export async function recordCommitAttribution(rows: CommitAttributionRow[]): Promise<void> {
  try {
    if (!rows || rows.length === 0) return;
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.git_sync_commit_attribution
        (workspace_id, harness_slug, repo, commit_sha, file, agent_id, session_id, work_item_id, plan_slug)
      SELECT * FROM unnest(
        ${rows.map((r) => r.workspaceId)}::text[],
        ${rows.map((r) => r.harnessSlug)}::text[],
        ${rows.map((r) => r.repo)}::text[],
        ${rows.map((r) => r.commitSha)}::text[],
        ${rows.map((r) => r.file)}::text[],
        ${rows.map((r) => r.agentId ?? null)}::text[],
        ${rows.map((r) => r.sessionId ?? null)}::text[],
        ${rows.map((r) => r.workItemId ?? null)}::text[],
        ${rows.map((r) => r.planSlug ?? null)}::text[]
      )
    `;
  } catch {
    // best-effort: commit attribution must never affect git-sync.
  }
}
