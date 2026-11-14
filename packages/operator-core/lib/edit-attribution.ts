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
import { getPresence } from './agent-tools/coordination/presence';
import { isLifecycleIntent } from './agent-tools/coordination/presence-payload';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import type { RunGit, GitSyncCandidateCapture, GitSyncCandidateDependency } from './harness/git-sync/run-git-sync';
import { canonicalJson } from './external-bench/reproducibility/canonical-json';
import { createHash } from 'node:crypto';
import type { ReleaseLockRow, ProtectReleasePaths } from '@papercusp/locks';
import { isAbsolute, join } from 'node:path';
import { hasValidGitEntry } from './agent-tools/locks/valid-git-entry';
import { EXTERNAL_LOCK_PREFIXES, managedRepositoryPathToLockIdentity } from './agent-tools/locks/external-path';
import { z } from 'zod';
import { AUTHORITY_KINDS, type AuthorityRevisionVector } from './governance-policy/effective-authority';

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
  /**
   * The caller's queue-time/current goal pointer. When present it is validated
   * against canonical work-item ownership and never replaced with a guessed
   * claim. Absent preserves the legacy claim-store fallback.
   */
  goalRef?: string;
  sessionId?: string;
  contributor?: string;
  /** Dispatcher call id for duplicate-safe server-side edit capture. */
  dispatchCallId?: string;
  /** Verified immutable custody from the protected edit operation. */
  captureReceipt?: Record<string, unknown>;
}

/**
 * How an edit row's work_item_id was chosen — persisted as
 * edit_attribution_ledger.work_item_resolution (migration 1599). Plan
 * change-provenance-and-admission-throughput-2026-10-27 P-005 (R-4).
 */
export type EditWorkItemResolution =
  | 'goal-ref' // the caller's goal pointer names an item the editor holds
  | 'goal-ref-unowned' // the pointer names nothing the editor holds: NULL, never a guess
  | 'single-holder' // the editor holds exactly one item
  | 'lock-intent' // several held; the lock's own intent names exactly one
  | 'declared-intent' // several held; the presence intent names exactly one
  | 'ambiguous' // several held, none singled out: NULL + candidates
  | 'none' // the editor holds nothing
  | 'lookup-failed' // the held-set read failed: NULL (unknown, not "none")
  | 'no-workspace'; // no workspace scope to resolve within

export interface HeldWorkItemRef {
  harnessSlug: string | null;
  workItemId: string;
}

export interface EditWorkItemChoice {
  harnessSlug: string | null;
  workItemId: string | null;
  resolution: EditWorkItemResolution;
  /** The held ids when no single one was chosen (ambiguous / goal-ref-unowned); else null. */
  candidates: string[] | null;
}

/** Held items whose id appears in `text` as a whole token (WI-12 never matches WI-123). */
function heldItemsNamedIn(text: string | null, held: readonly HeldWorkItemRef[]): HeldWorkItemRef[] {
  if (!text) return [];
  return held.filter((item) => {
    const id = item.workItemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_-])${id}(?![A-Za-z0-9_])`).test(text);
  });
}

/**
 * Pure: choose the work-item an edit belongs to from what its editor HOLDS. A goal pointer
 * wins when it names a held item and yields an honest NULL when it does not (it never falls
 * through to a different item). Otherwise one held item is stamped; several are narrowed by
 * the lock intent, then the declared presence intent, each only when it names exactly one;
 * anything else stays NULL with the held ids as candidates, so "ambiguous" is readable apart
 * from "held nothing". `held === null` means the read failed — unknown, never "none".
 */
export function resolveEditWorkItem(input: {
  goalRef: string | null;
  held: readonly HeldWorkItemRef[] | null;
  lockIntent: string | null;
  declaredIntent: string | null;
}): EditWorkItemChoice {
  const chose = (item: HeldWorkItemRef, resolution: EditWorkItemResolution): EditWorkItemChoice => ({
    harnessSlug: item.harnessSlug,
    workItemId: item.workItemId,
    resolution,
    candidates: null,
  });
  const unresolved = (resolution: EditWorkItemResolution, candidates: string[] | null = null): EditWorkItemChoice => ({
    harnessSlug: null,
    workItemId: null,
    resolution,
    candidates,
  });
  const { held } = input;
  if (held === null) return unresolved('lookup-failed');
  const ids = held.map((item) => item.workItemId);
  if (input.goalRef) {
    const item = held.find((h) => h.workItemId === input.goalRef);
    return item ? chose(item, 'goal-ref') : unresolved('goal-ref-unowned', ids.length > 0 ? ids : null);
  }
  if (held.length === 0) return unresolved('none');
  if (held.length === 1) return chose(held[0]!, 'single-holder');
  const byLock = heldItemsNamedIn(input.lockIntent, held);
  if (byLock.length === 1) return chose(byLock[0]!, 'lock-intent');
  const byIntent = heldItemsNamedIn(input.declaredIntent, held);
  if (byIntent.length === 1) return chose(byIntent[0]!, 'declared-intent');
  return unresolved('ambiguous', ids);
}

/** Cap on the held set read per edit; a holder past it is pathological, and the cap bounds the candidates array. */
const EDIT_HELD_SET_LIMIT = 100;

/**
 * The editor's non-terminal held work-items (work_items.taken_by), observation lane
 * excluded. Returns null when the read fails so the caller records 'lookup-failed'.
 * carry-brief's readHeldWorkItems also loads summaries and checkpoints — too heavy for the
 * per-edit lock path — so this is the two-column form of the same population.
 */
async function readEditorHeldWorkItems(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  agentId: string,
): Promise<HeldWorkItemRef[] | null> {
  try {
    const rows = await sql<Array<{ harness_slug: string | null; feature_id: string }>>`
      SELECT harness_slug, feature_id
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND taken_by = ${agentId}
         AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
         AND lane IS DISTINCT FROM 'observation'
       ORDER BY feature_id
       LIMIT ${EDIT_HELD_SET_LIMIT}
    `;
    return rows.map((row) => ({ harnessSlug: row.harness_slug, workItemId: row.feature_id }));
  } catch {
    return null;
  }
}

/**
 * Append edit-attribution ledger rows for a just-granted lock. Resolves the work-item from
 * the editor's held set (resolveEditWorkItem), records how it was chosen, then writes one
 * row per file. Never throws (except in strict mode).
 */
export async function recordEditAttribution(
  input: RecordEditAttributionInput,
  opts: { strict?: boolean; awaitSymbols?: boolean } = {},
): Promise<void> {
  try {
    const files = (input.files ?? []).filter(Boolean);
    if (files.length === 0 || !input.agentId || !input.repoRoot) return;

    const { sql } = getOrgPg();

    // The work-item join, at edit time (D-002), resolved from the HELD set — the editor's
    // non-terminal work_items.taken_by rows — never from the short-lived work_item_claims
    // lease. Plan change-provenance-and-admission-throughput-2026-10-27 P-005 (R-4): the
    // lease held 13 rows fleet-wide while 1,185 of 2,167 unstamped Claude edits in 24 h came
    // from agents that DID hold an item. Started here, awaited after presence (it needs the
    // declared intent), so the two reads overlap on this per-edit hot path.
    const heldRead = input.workspaceId
      ? readEditorHeldWorkItems(sql, input.workspaceId, input.agentId)
      : null;

    // WI-6584: plan_slug was UNCONDITIONALLY written as NULL here — the input type didn't
    // even carry a planSlug field, so there was nothing to thread even if a caller wanted to.
    // `work_item_claims` (the join above) has no plan_slug column at all (a work-item claim
    // and a declared plan lane are different things), so the only live source for "which plan
    // is this agent working under, right now" is its own presence row (coord:declare-intent /
    // coord:orient write `current_plan_slug` there — agent-coordination-architecture-v2 §4.2).
    // One more cheap single-row indexed read (by agentId, overlapping the held-set read above);
    // best-effort like everything else here — absent/stale presence just means an honest
    // unattributed plan_slug, never a guess.
    let planSlug: string | null = null;
    const presence = await getPresence(input.agentId).catch(() => null);
    if (presence?.currentPlanSlug) planSlug = presence.currentPlanSlug;

    // EI-20055604348536487: `intent` must carry what the agent said it was DOING (D-002) — but
    // the automatic per-edit file-lock hook acquires with `intent: f'PreToolUse:{tool_name}'`,
    // and locks:acquire passes that straight through, so 97.5% of this column was the name of
    // the hook rather than any intent (measured 24h/n=3,257: 3,047 'PreToolUse:Edit' + 210
    // 'PreToolUse:Write' vs ~50 real). git-sync renders this field as the COMMIT SUBJECT, so
    // the sentinel was one reader-side filter away from becoming fleet-wide commit messages.
    //
    // The agent's declared coord intent is ALREADY in hand — `presence` is fetched just above
    // for plan_slug (WI-6584) — so recovering the real value costs NO extra query on this
    // per-edit hot path. The lifecycle label moves to `acquired_via` (784) rather than being
    // discarded: it is the only thing the column carried, and "did this edit come through the
    // automatic hook" stays worth knowing.
    //
    // HONEST LIMIT: a declared intent can be STALE (declared at orient, not re-declared since),
    // so this is "what the agent last said it was doing", not proof of this edit's purpose. That
    // is the same freshness the plan_slug above and enrich-busy's `holder_intent` already accept,
    // and it is strictly better than a label that describes no work at all. When neither side has
    // a usable intent we write NULL — an honest unattributed edit (D-003), never a guess.
    const rawIntent = input.intent?.trim() || null;
    const lifecycleLabel = isLifecycleIntent(rawIntent);
    const declaredIntent = presence?.intent?.trim() || null;
    const intent = lifecycleLabel
      ? isLifecycleIntent(declaredIntent)
        ? null
        : declaredIntent
      : rawIntent;
    const acquiredVia = lifecycleLabel ? rawIntent : null;

    const choice: EditWorkItemChoice = heldRead
      ? resolveEditWorkItem({
          goalRef: input.goalRef?.trim() || null,
          held: await heldRead,
          lockIntent: lifecycleLabel ? null : rawIntent,
          declaredIntent: isLifecycleIntent(declaredIntent) ? null : declaredIntent,
        })
      : { harnessSlug: null, workItemId: null, resolution: 'no-workspace', candidates: null };
    const { harnessSlug, workItemId } = choice;

    if (input.captureReceipt && input.captureReceipt.kind !== 'unpreserved-edit' &&
        input.dispatchCallId && input.workspaceId && workItemId && harnessSlug) {
      // Extend the existing work-item payload rather than creating a cohort
      // table. Row-update serialization merges concurrent files/sessions and
      // retains every operation's immutable membership. No readiness is inferred.
      const cohort = await sql<{ feature_id: string }[]>`
        UPDATE harness_shared.work_items
           SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{gitSyncLifecycle}',
             COALESCE(payload->'gitSyncLifecycle', '{}'::jsonb) || jsonb_build_object('version', 1, 'captures',
               COALESCE(payload->'gitSyncLifecycle'->'captures', '{}'::jsonb)
                 || jsonb_build_object(${input.dispatchCallId}::text,
                   CASE WHEN payload->'gitSyncLifecycle'->'captures'->${input.dispatchCallId}::text->'pending' = 'false'::jsonb
                     THEN payload->'gitSyncLifecycle'->'captures'->${input.dispatchCallId}::text
                     ELSE ${JSON.stringify(input.captureReceipt)}::text::jsonb END)))
         WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${harnessSlug}
           AND feature_id = ${workItemId} AND taken_by = ${input.agentId}
           AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
           AND (payload->'gitSyncLifecycle'->'captures'->${input.dispatchCallId}::text IS NULL
             OR (payload->'gitSyncLifecycle'->'captures'->${input.dispatchCallId}::text) - 'pending'
               = ${JSON.stringify(input.captureReceipt)}::text::jsonb - 'pending')
        RETURNING feature_id
      `;
      if (cohort.length !== 1) throw new Error('edit-cohort-refused:ownership-or-generation-changed');
    }

    // One row per file via unnest — a single round-trip on the hot path.
    const inserted = await sql<{ id: string; file: string }[]>`
      INSERT INTO harness_shared.edit_attribution_ledger
        (repo_root, file, agent_id, session_id, contributor, workspace_id,
         harness_slug, work_item_id, plan_slug, intent, acquired_via, dispatch_call_id,
         work_item_resolution, work_item_candidates)
      SELECT ${input.repoRoot}, f, ${input.agentId}, ${input.sessionId ?? null},
             ${input.contributor ?? null}, ${input.workspaceId ?? null},
             ${harnessSlug}, ${workItemId}, ${planSlug}, ${intent}, ${acquiredVia},
             ${input.dispatchCallId ?? null},
             ${choice.resolution}, ${choice.candidates}::text[]
        FROM unnest(${files}::text[]) AS f
      ON CONFLICT DO NOTHING
      RETURNING id::text, file
    `;

    // P-007 (code-intel-delivery-and-outcomes-2026-10-26): stamp the enclosing
    // function/class names of the edit on the rows just written. It runs off the
    // lock path (git show + one compiler parse per file) unless a caller awaits
    // it; a capture that cannot measure leaves `symbols` NULL (unknown).
    if (Array.isArray(inserted) && inserted.length > 0) {
      const capture = import('./code-intelligence/edited-symbols')
        .then(({ fillEditedSymbols }) => fillEditedSymbols(inserted, input.repoRoot, sql))
        .catch(() => 0);
      // P-002 (same plan, D-018): journal edit-time interface eligibility on the same
      // rows, the independent denominator the `interface` push leg's liveness reads.
      // Peers are scoped by the row's harness, else the editor's presence pot.
      const interfaceCapture = import('./code-intelligence/edit-interface-capture')
        .then(({ fillInterfaceEligibility }) => fillInterfaceEligibility(inserted, {
          repoRoot: input.repoRoot, workspaceId: input.workspaceId ?? null, rowHarnessSlug: harnessSlug,
          scopeHarness: harnessSlug ?? presence?.potSlug ?? null, agentId: input.agentId,
        }, sql))
        .catch(() => 0);
      if (opts.awaitSymbols) await Promise.all([capture, interfaceCapture]);
    }
  } catch (error) {
    // best-effort: edit attribution must NEVER break the lock path — except for the
    // one caller that needs the row to exist (strict, below).
    if (opts.strict) throw error;
  }
}

/**
 * The same write, but it THROWS when the insert fails instead of swallowing it.
 * Plan personal-data-reader-set-labels-2026-10-01 P-014 (WI-10005571): for an owner
 * holding an active personal disclosure, this row is what holds the edited path out
 * of git-sync (personal-vault/git-sync-hold.ts), so locks:release writes it BEFORE
 * releasing and keeps the lock when the write fails. Every other caller stays
 * best-effort.
 */
export async function recordEditAttributionStrict(input: RecordEditAttributionInput): Promise<void> {
  await recordEditAttribution(input, { strict: true });
}

/** Called while the operation's edit fence is still held. The existing
 * operation JSONB owns this receipt; custody refs own the immutable bytes.
 * Replay reads that custody and never samples a successor's working files. */
export async function preserveEditGeneration(
  input: RecordEditAttributionInput & {
    dispatchCallId: string;
    operationState: 'pending' | 'granted' | 'cancelled' | 'completed';
    captureReceipt?: Record<string, unknown>;
  },
  runGitOverride?: RunGit,
  predecessors: typeof readEditPredecessors = readEditPredecessors,
): Promise<Record<string, unknown>> {
  if (!input.captureReceipt && input.operationState !== 'granted') {
    throw new Error('edit-capture-refused:operation-no-longer-protects-version');
  }
  const external = input.files.some(path => EXTERNAL_LOCK_PREFIXES.some(prefix =>
    path === prefix || path.startsWith(`${prefix}/`)));
  if (external || !hasValidGitEntry(input.repoRoot)) {
    const receipt = { version: 1, kind: 'unpreserved-edit', pending: false,
      reason: external ? 'external-path' : 'non-repository', repoRoot: input.repoRoot,
      files: [...new Set(input.files)].sort(), agentId: input.agentId,
      workspaceId: input.workspaceId ?? null, goalRef: input.goalRef ?? null };
    if (input.captureReceipt && canonicalJson(input.captureReceipt) !== canonicalJson(receipt)) {
      throw new Error('edit-capture-refused:receipt-identity-mismatch');
    }
    return input.captureReceipt ?? receipt;
  }
  const { captureGitSyncCandidate, readGitSyncCandidate, runGitBounded, gitTimeoutMsFor } =
    await import('./harness/git-sync/run-git-sync');
  const executeGit: RunGit = runGitOverride ?? ((args, cwd, options) =>
    runGitBounded(args, cwd, gitTimeoutMsFor(args), options));
  // Correlate custody failures through the existing safe sidecar telemetry;
  // Git output can contain protected source and must stay out of errors.
  const runGit: RunGit = (args, cwd, options) => executeGit(args, cwd, {
    ...options,
    diagnosticTags: options?.diagnosticTags ?? {
      runId: input.dispatchCallId, commandClass: 'git',
    },
  });
  const request = { requestId: input.dispatchCallId, generation: 1, paths: input.files };
  let captured = await readGitSyncCandidate(runGit, input.repoRoot, request);
  if (!captured.ok) {
    // An acknowledged receipt is never repaired by reading moving content.
    if (input.captureReceipt || captured.error !== 'source-custody-refused:candidate-not-captured') {
      throw new Error(captured.error);
    }
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], input.repoRoot,
      { env: { GIT_OPTIONAL_LOCKS: '0' } });
    // Rev-parse alone cannot distinguish unborn from a corrupt repository.
    const base: string | null = head.code === 0 ? head.stdout.trim() : null;
    if (base === null) {
      const symbolic = await runGit(['symbolic-ref', '-q', 'HEAD'], input.repoRoot);
      const missing = symbolic.code === 0
        ? await runGit(['show-ref', '--verify', '--quiet', symbolic.stdout.trim()], input.repoRoot)
        : null;
      if (missing?.code !== 1) throw new Error('edit-capture-refused:base-unreadable');
    }
    const dependencies = await predecessors(input, runGit);
    captured = await captureGitSyncCandidate(runGit, input.repoRoot, { ...request, base, dependencies });
    if (!captured.ok) throw new Error(captured.error);
  }
  const receipt = {
    version: 1, kind: 'edit-generation', pending: true,
    workspaceId: input.workspaceId ?? null, agentId: input.agentId,
    goalRef: input.goalRef ?? null, capture: captured,
  };
  if (input.captureReceipt) {
    // Settlement is mutable; the identity and preserved content are not.
    if (canonicalJson({ ...input.captureReceipt, pending: true }) !== canonicalJson(receipt)) {
      throw new Error('edit-capture-refused:receipt-identity-mismatch');
    }
    return input.captureReceipt;
  }
  return receipt;
}

/** The existing per-file ledger is the handoff history, including nullable
 * attribution. Resolve the last acknowledged operation while the next editor
 * still holds these paths. Legacy/missing custody stays an unknown dependency.
 * The result is pinned in the new custody manifest before the release receipt. */
export async function readEditPredecessors(
  input: RecordEditAttributionInput & { dispatchCallId: string },
  runGit: RunGit,
): Promise<GitSyncCandidateDependency[]> {
  if (!input.workspaceId) return [];
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ file: string; dispatch_call_id: string }>>`
    SELECT DISTINCT ON (file) file, COALESCE(dispatch_call_id, 'legacy-ledger:' || id::text) AS dispatch_call_id
      FROM harness_shared.edit_attribution_ledger
     WHERE workspace_id = ${input.workspaceId} AND repo_root = ${input.repoRoot}
       AND EXISTS (SELECT 1 FROM unnest(${input.files}::text[]) AS wanted(path)
         WHERE file = wanted.path OR starts_with(file, wanted.path || '/') OR starts_with(wanted.path, file || '/'))
       AND dispatch_call_id IS DISTINCT FROM ${input.dispatchCallId}
     ORDER BY file, ts DESC, id DESC
  `;
  const grouped = new Map<string, string[]>();
  for (const row of rows) grouped.set(row.dispatch_call_id, [...new Set([
    ...(grouped.get(row.dispatch_call_id) ?? []), ...input.files.filter(path => path === row.file ||
      path.startsWith(row.file + '/') || row.file.startsWith(path + '/')),
  ])]);
  const { readGitSyncCandidate } = await import('./harness/git-sync/run-git-sync');
  return Promise.all([...grouped].map(async ([requestId, paths]) => {
    const previous = await readGitSyncCandidate(runGit, input.repoRoot, { requestId, generation: 1 });
    if (!previous.ok && previous.error !== 'source-custody-refused:candidate-not-captured') {
      throw new Error(previous.error);
    }
    return { requestId, generation: 1, paths: paths.sort(), tree: previous.ok ? previous.candidate.tree : null };
  }));
}

const cohortCaptureSchema = z.object({
  kind: z.literal('edit-generation'),
  capture: z.object({
    ok: z.literal(true), ref: z.string().min(1),
    candidate: z.object({
      version: z.literal(2), kind: z.literal('candidate'), repository: z.string().min(1),
      requestId: z.string().min(1), generation: z.number().int().positive(),
      base: z.string().nullable(), baseTree: z.string().min(1), tree: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
      dependencies: z.array(z.object({ requestId: z.string().min(1), generation: z.number().int().positive(),
        paths: z.array(z.string().min(1)).min(1), tree: z.string().nullable() })).optional(),
    }),
  }),
});

export interface FrozenEditCohort {
  version: 1;
  identity: string;
  members: Array<{ operationId: string; ref: string; candidate: GitSyncCandidateCapture }>;
  configurationIdentity: string;
  environmentIdentity: string;
  requiredChecks: string[];
}

/** A reconciled vector of pinned generations, never separately sampled live
 * files. Overlapping members must have an explicit causal order. The frozen
 * vector is only a check subject; it neither requests publication nor verifies
 * the candidate. Mutable settlement/session/lease fields do not identify bytes. */
export function describeEditCohort(
  captures: Record<string, unknown>,
  context: Pick<FrozenEditCohort, 'configurationIdentity' | 'environmentIdentity' | 'requiredChecks'>,
): FrozenEditCohort {
  if (!context.configurationIdentity || !context.environmentIdentity || !context.requiredChecks.length ||
      context.requiredChecks.some(check => !check)) throw new Error('edit-cohort-refused:verification-context-missing');
  const members = Object.entries(captures).map(([operationId, value]) => {
    const parsed = cohortCaptureSchema.parse(value).capture;
    if (parsed.candidate.requestId !== operationId) throw new Error('edit-cohort-refused:operation-identity-mismatch');
    return { operationId, ref: parsed.ref, candidate: parsed.candidate };
  }).sort((a, b) => a.operationId.localeCompare(b.operationId));
  if (!members.length) throw new Error('edit-cohort-refused:no-captures');
  const byId = new Map(members.map(member => [member.operationId, member]));
  function ancestors(id: string, visiting = new Set<string>()): Set<string> {
    if (visiting.has(id)) throw new Error('edit-cohort-refused:dependency-cycle');
    const next = new Set(visiting).add(id);
    const dependencies = byId.get(id)?.candidate.dependencies ?? [];
    const result = new Set<string>();
    for (const dependency of dependencies) {
      const provider = byId.get(dependency.requestId);
      if (provider && (provider.candidate.repository !== byId.get(id)!.candidate.repository ||
          provider.candidate.generation !== dependency.generation || provider.candidate.tree !== dependency.tree)) {
        throw new Error('edit-cohort-refused:dependency-identity-mismatch');
      }
      result.add(dependency.requestId);
      if (provider) for (const ancestor of ancestors(provider.operationId, next)) result.add(ancestor);
    }
    return result;
  }
  const ancestry = new Map(members.map(member => [member.operationId, ancestors(member.operationId)]));
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    const a = members[i], b = members[j];
    if (a.candidate.repository !== b.candidate.repository) continue;
    if (a.candidate.base !== b.candidate.base) throw new Error('edit-cohort-refused:incompatible-bases');
    const overlaps = a.candidate.paths.some(path => b.candidate.paths.some(other =>
      path === other || path.startsWith(other + '/') || other.startsWith(path + '/')));
    if (overlaps && !ancestry.get(a.operationId)!.has(b.operationId) && !ancestry.get(b.operationId)!.has(a.operationId)) {
      throw new Error('edit-cohort-refused:unordered-overlapping-generations');
    }
  }
  const content = { version: 1 as const, members, configurationIdentity: context.configurationIdentity,
    environmentIdentity: context.environmentIdentity, requiredChecks: [...new Set(context.requiredChecks)].sort() };
  return { ...content, identity: createHash('sha256').update(canonicalJson(content)).digest('hex') };
}

/** Persist on the existing work-item. The captures CAS prevents a check subject
 * from dropping an edit that arrived between read and freeze. No session/lease
 * predicate: unfinished work outlives both. New captures invalidate old proof. */
export async function freezeEditCohort(input: {
  workspaceId: string; harnessSlug: string; workItemId: string;
} & Pick<FrozenEditCohort, 'configurationIdentity' | 'environmentIdentity' | 'requiredChecks'>): Promise<FrozenEditCohort> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ captures: Record<string, unknown> | null }>>`
    SELECT payload->'gitSyncLifecycle'->'captures' AS captures FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug} AND feature_id = ${input.workItemId}
  `;
  if (rows.length !== 1 || !rows[0].captures) throw new Error('edit-cohort-refused:no-captures');
  const captures = rows[0].captures;
  const frozen = describeEditCohort(captures, input);
  const saved = await sql<Array<{ feature_id: string }>>`
    UPDATE harness_shared.work_items
       SET payload = jsonb_set(payload, '{gitSyncLifecycle,frozen}', ${JSON.stringify(frozen)}::text::jsonb)
     WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug} AND feature_id = ${input.workItemId}
       AND payload->'gitSyncLifecycle'->'captures' = ${JSON.stringify(captures)}::text::jsonb
    RETURNING feature_id
  `;
  if (saved.length !== 1) throw new Error('edit-cohort-refused:membership-changed');
  return frozen;
}

const prospectiveSubjectScope = z.object({
  workspaceId: z.string().min(1), harnessSlug: z.string().min(1), workItemId: z.string().min(1),
  actorId: z.string().min(1), originalOperationId: z.string().min(1),
}).strict();

/** Storage identity only. The trusted ingress must derive the scope, resolve the
 * current applied rule and every restriction, and retain its writer fence. This
 * primitive grants no source operation, performs no Git work, and is not exposed
 * as a tool. Its ONE slot is on the source item, never a request/rule-keyed map. */
export interface ProspectiveEditSubjectInput {
  workspaceId: string; harnessSlug: string; workItemId: string; actorId: string;
  originalOperationId: string;
  originalReceipt: Record<string, unknown>;
  binding: {
    rule: { amendmentKey: string; decisionId: string; ruleSha256: string;
      rubricRevision: number; subjectRevision: number };
    /** Full detached ingress request, including base/baseTree/payload and pins. */
    request: Record<string, unknown>;
    independentExpectationSha256: string;
    /** Identity retention only. The host must authenticate these observations,
     * all remaining freezes and its writer fence before any source effect.
     * Omitted legacy bindings never establish production admission. */
    hostEvidence?: {
      authorityRevisions: AuthorityRevisionVector;
      /** Digest from the ORIGINAL-bound v2 restriction census, not root-only v1. */
      originalRestrictionCensusSha256: string;
    };
  };
}

const prospectiveAuthorityRevisionsSchema = z.object({
  contextRevision: z.string().min(1),
  authorities: z.array(z.object({
    kind: z.enum(AUTHORITY_KINDS), id: z.string().min(1), revision: z.string().min(1),
  }).strict()).min(1),
}).strict().refine(value => {
  const keys = value.authorities.map(ref => canonicalJson([ref.kind, ref.id]));
  return new Set(keys).size === keys.length && AUTHORITY_KINDS.filter(kind => kind !== 'vault')
    .every(kind => value.authorities.some(ref => ref.kind === kind));
}, 'authority revision population is incomplete or duplicated');

const prospectiveBindingSchema = z.object({
  rule: z.object({ amendmentKey: z.string().min(1), decisionId: z.string().min(1),
    ruleSha256: z.string().regex(/^[a-f0-9]{64}$/), rubricRevision: z.number().int().positive(),
    subjectRevision: z.number().int().positive() }).strict(),
  request: z.record(z.string(), z.unknown()),
  independentExpectationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  hostEvidence: z.object({
    authorityRevisions: prospectiveAuthorityRevisionsSchema,
    originalRestrictionCensusSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
}).strict();

/** Reject non-JSON/ambiguous input before hashing or entering the row CAS. */
function prospectiveJson(value: unknown): string {
  const visit = (item: unknown, seen: Set<object>): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' ||
        typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) throw new Error('prospective-subject-refused:json');
    const next = new Set(seen).add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) {
        throw new Error('prospective-subject-refused:json');
      }
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(Object.getOwnPropertyDescriptor(item, i) ?? {}, 'value')) {
          throw new Error('prospective-subject-refused:json');
        }
        visit(item[i], next);
      }
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null ||
          Reflect.ownKeys(item).some(key => typeof key !== 'string' ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key) ?? {}, 'value'))) {
        throw new Error('prospective-subject-refused:json');
      }
      for (const entry of Object.values(item)) visit(entry, next);
    }
  };
  visit(value, new Set());
  return canonicalJson(value);
}

function prospectiveSubjectSnapshot(input: ProspectiveEditSubjectInput) {
  // Detach before the first await, including the complete original wrapper.
  const detached = JSON.parse(prospectiveJson(input)) as ProspectiveEditSubjectInput;
  const { originalReceipt, binding, ...scope } = detached;
  prospectiveSubjectScope.parse(scope);
  prospectiveBindingSchema.parse(binding);
  const original = cohortCaptureSchema.parse(originalReceipt);
  if (originalReceipt.workspaceId !== scope.workspaceId || originalReceipt.agentId !== scope.actorId ||
      originalReceipt.goalRef !== scope.workItemId || original.capture.candidate.requestId !== scope.originalOperationId) {
    throw new Error('prospective-subject-refused:original-scope');
  }
  const identity = { version: 1, originalOperationId: scope.originalOperationId, originalReceipt, binding };
  return { scope, originalReceipt, identity,
    identitySha256: createHash('sha256').update(prospectiveJson(identity)).digest('hex') };
}

/** Empty -> reserved, or exact replay. Neither a crash nor a different request,
 * root, expectation or rule can release/reset this slot. The short atomic SQL
 * update also fences current custody and the exact original wrapper. */
export async function reserveProspectiveEditSubject(input: ProspectiveEditSubjectInput): Promise<{
  identitySha256: string; state: 'reserved' | 'recorded'; result: Record<string, unknown> | null;
}> {
  const { scope, originalReceipt, identity, identitySha256 } = prospectiveSubjectSnapshot(input);
  const slot = { ...identity, identitySha256, state: 'reserved', result: null };
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ slot: { state: unknown; result?: unknown } }>>`
    UPDATE harness_shared.work_items
       SET payload = jsonb_set(payload, '{gitSyncLifecycle,prospectiveSubject}',
         CASE WHEN payload->'gitSyncLifecycle' ? 'prospectiveSubject'
           THEN payload->'gitSyncLifecycle'->'prospectiveSubject'
           ELSE ${JSON.stringify(slot)}::text::jsonb END)
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
       AND feature_id = ${scope.workItemId} AND taken_by = ${scope.actorId}
       AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
       AND payload->'gitSyncLifecycle'->'captures'->${scope.originalOperationId}::text
         = ${JSON.stringify(originalReceipt)}::text::jsonb
       AND (NOT (payload->'gitSyncLifecycle' ? 'prospectiveSubject')
         OR (payload->'gitSyncLifecycle'->'prospectiveSubject') - 'state' - 'result'
           = ${JSON.stringify({ ...identity, identitySha256 })}::text::jsonb)
    RETURNING payload->'gitSyncLifecycle'->'prospectiveSubject' AS slot
  `;
  const saved = rows[0]?.slot;
  if (rows.length !== 1 || !saved ||
      !(saved.state === 'reserved' && saved.result === null ||
        saved.state === 'recorded' && saved.result !== null && typeof saved.result === 'object' && !Array.isArray(saved.result))) {
    throw new Error('prospective-subject-refused:ownership-original-or-binding');
  }
  return { identitySha256, state: saved.state as 'reserved' | 'recorded',
    result: saved.result as Record<string, unknown> | null };
}

/** Persist the ingress's already validated exact result on the SAME slot. A lost
 * response can be retried; a different result cannot replace the first one.
 * Recording bytes is not independent packet admission or proof of a Git effect. */
export async function recordProspectiveEditSubjectResult(
  input: ProspectiveEditSubjectInput, result: Record<string, unknown>,
): Promise<void> {
  const { scope, originalReceipt, identity, identitySha256 } = prospectiveSubjectSnapshot(input);
  const detachedResult = JSON.parse(prospectiveJson(result)) as Record<string, unknown>;
  if (!detachedResult || Array.isArray(detachedResult) || typeof detachedResult !== 'object') {
    throw new Error('prospective-subject-refused:result');
  }
  const storedIdentity = JSON.stringify({ ...identity, identitySha256 });
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ feature_id: string }>>`
    UPDATE harness_shared.work_items
       SET payload = jsonb_set(payload, '{gitSyncLifecycle,prospectiveSubject}',
         payload->'gitSyncLifecycle'->'prospectiveSubject'
           || jsonb_build_object('state', 'recorded', 'result', ${JSON.stringify(detachedResult)}::text::jsonb))
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
       AND feature_id = ${scope.workItemId} AND taken_by = ${scope.actorId}
       AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
       AND payload->'gitSyncLifecycle'->'captures'->${scope.originalOperationId}::text
         = ${JSON.stringify(originalReceipt)}::text::jsonb
       AND (payload->'gitSyncLifecycle'->'prospectiveSubject') - 'state' - 'result'
         = ${storedIdentity}::text::jsonb
       AND ((payload->'gitSyncLifecycle'->'prospectiveSubject'->>'state' = 'reserved'
             AND payload->'gitSyncLifecycle'->'prospectiveSubject'->'result' = 'null'::jsonb)
         OR (payload->'gitSyncLifecycle'->'prospectiveSubject'->>'state' = 'recorded'
             AND payload->'gitSyncLifecycle'->'prospectiveSubject'->'result' = ${JSON.stringify(detachedResult)}::text::jsonb))
    RETURNING feature_id
  `;
  if (rows.length !== 1) throw new Error('prospective-subject-refused:result-cas');
}

/** Exact pre-publication evidence, independent of later committed-build and
 * final acceptance proof. A turn-end, session death or capture is no intent.
 * Dependency proofs come from the existing publisher's exact object receipts. */
export function checkFrozenEditCohortEvidence(input: {
  frozen: FrozenEditCohort; captures: Record<string, unknown>;
  configurationIdentity: string; environmentIdentity: string; publicationIntent: boolean;
  checks: Array<{ check: string; identity: string; environmentIdentity: string; passed: boolean; runId: string }>;
  dependencies: Array<{ repository: string; requestId: string; generation: number; tree: string }>;
}): { ok: true } | { ok: false; reason: string } {
  let current: FrozenEditCohort;
  try { current = describeEditCohort(input.captures, { ...input, requiredChecks: input.frozen.requiredChecks }); }
  catch { return { ok: false, reason: 'cohort-invalid' }; }
  if (current.identity !== input.frozen.identity) return { ok: false, reason: 'cohort-changed' };
  if (!input.publicationIntent) return { ok: false, reason: 'cohort-unfinished' };
  for (const check of current.requiredChecks) {
    if (!input.checks.some(proof => proof.check === check && proof.passed && proof.runId &&
        proof.identity === current.identity && proof.environmentIdentity === current.environmentIdentity)) {
      return { ok: false, reason: 'cohort-check-missing-or-stale' };
    }
  }
  for (const member of current.members) for (const dependency of member.candidate.dependencies ?? []) {
    if (!dependency.tree || !input.dependencies.some(proof => proof.repository === member.candidate.repository && proof.requestId === dependency.requestId &&
        proof.generation === dependency.generation && proof.tree === dependency.tree)) {
      return { ok: false, reason: 'cohort-ancestor-unfinished' };
    }
  }
  return { ok: true };
}

/** Explicit release has no per-edit hook id. Derive replay identity from the
 * exact selected lease generations, not moving file bytes or release time.
 * The caller invokes this inside tryRelease's protected selection callback.
 * Non-repository/home keys retain their existing release policy; no Git
 * preservation guarantee is made for those paths. */
export async function preserveReleasedEditGenerations(
  input: Omit<RecordEditAttributionInput, 'files' | 'dispatchCallId' | 'captureReceipt'> & {
    rows: ReleaseLockRow[];
    protectRepositoryPaths?: ProtectReleasePaths;
  },
  dependencies: {
    preserve?: typeof preserveEditGeneration;
    attribute?: typeof recordEditAttributionStrict;
  } = {},
): Promise<boolean> {
  const rows = input.rows.filter(row => !EXTERNAL_LOCK_PREFIXES.some(prefix =>
    row.path === prefix || row.path.startsWith(`${prefix}/`)));
  if (!rows.length || !hasValidGitEntry(input.repoRoot)) return false;
  const groups = new Map<string, ReleaseLockRow[]>();
  for (const row of rows) {
    const key = canonicalJson({ lockId: row.lock_id, goalRef: row.goal_ref, intent: row.intent });
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const coordinates = new Map(rows.map(row => {
    const identity = isAbsolute(input.repoRoot)
      ? managedRepositoryPathToLockIdentity(join(input.repoRoot, row.path)) : undefined;
    return [row.path, { repoRoot: identity?.coordinationDomain ?? input.repoRoot,
      path: identity?.path ?? row.path }];
  }));
  const aliases = rows.filter(row => coordinates.get(row.path)!.repoRoot !== input.repoRoot);
  if (aliases.length) {
    if (!input.protectRepositoryPaths) throw new Error('edit-capture-refused:alias-protection-required');
    const scopes = new Map<string, string[]>();
    for (const row of aliases) {
      const coordinate = coordinates.get(row.path)!;
      scopes.set(coordinate.repoRoot, [...(scopes.get(coordinate.repoRoot) ?? []), coordinate.path]);
    }
    // Protect every child before the first capture, including mixed cohorts.
    for (const [repoRoot, paths] of [...scopes].sort(([a], [b]) => a.localeCompare(b))) {
      await input.protectRepositoryPaths(repoRoot, [...new Set(paths)].sort());
    }
  }
  const leaseIdentity = (selected: ReleaseLockRow[]) => selected.map(row => ({
    path: row.path, lockId: row.lock_id,
    acquiredAt: row.acquired_identity ?? row.acquired_ts.toISOString(),
  }));
  for (const selected of groups.values()) {
    selected.sort((a, b) => a.path.localeCompare(b.path));
    const dispatchCallId = 'release:' + createHash('sha256').update(canonicalJson(
      leaseIdentity(selected),
    )).digest('hex');
    const remapped = selected.some(row => coordinates.get(row.path)!.repoRoot !== input.repoRoot);
    if (remapped) {
      // Never reinterpret an acknowledged parent capture as fresh child input.
      // This probe reads immutable Git objects, not moving working bytes.
      const { readGitSyncCandidate, runGitBounded, gitTimeoutMsFor } = await import('./harness/git-sync/run-git-sync');
      const old = await readGitSyncCandidate((args, cwd, options) =>
        runGitBounded(args, cwd, gitTimeoutMsFor(args), options), input.repoRoot,
      { requestId: dispatchCallId, generation: 1, paths: selected.map(row => row.path) });
      if (old.ok) throw new Error('edit-capture-refused:acknowledged-alias-remap');
      if (old.error !== 'source-custody-refused:candidate-not-captured') throw new Error(old.error);
    }
    const repositories = new Map<string, ReleaseLockRow[]>();
    for (const row of selected) {
      const repoRoot = coordinates.get(row.path)!.repoRoot;
      repositories.set(repoRoot, [...(repositories.get(repoRoot) ?? []), row]);
    }
    for (const [repoRoot, repositoryRows] of [...repositories].sort(([a], [b]) => a.localeCompare(b))) {
      const releaseSource = remapped ? { coordinationDomain: input.repoRoot,
        leases: leaseIdentity(selected) } : undefined;
      const repositoryDispatchId = remapped ? 'release:' + createHash('sha256').update(canonicalJson({
        releaseSource, repoRoot, paths: repositoryRows.map(row => coordinates.get(row.path)!.path).sort(),
      })).digest('hex') : dispatchCallId;
      const edit = { repoRoot, files: repositoryRows.map(row => coordinates.get(row.path)!.path).sort(), agentId: input.agentId,
        workspaceId: input.workspaceId, contributor: input.contributor, sessionId: input.sessionId,
        intent: selected[0].intent, goalRef: selected[0].goal_ref ?? undefined, dispatchCallId: repositoryDispatchId };
      const receipt = await (dependencies.preserve ?? preserveEditGeneration)({ ...edit, operationState: 'granted' });
      await (dependencies.attribute ?? recordEditAttributionStrict)({ ...edit,
        captureReceipt: releaseSource ? { ...receipt, releaseSource } : receipt });
    }
  }
  return true;
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
  /** Latest edit timestamp for each repo-relative file in this provenance cohort. */
  editedAtMsByFile?: Record<string, number>;
}

interface LedgerRow {
  agent_id: string;
  file: string;
  work_item_id: string | null;
  plan_slug: string | null;
  intent: string | null;
  session_id: string | null;
  contributor: string | null;
  edited_at_ms?: number | string | null;
}

/**
 * Build git-sync's attribution roster for a repo from the edit ledger (P-003) — the
 * DURABLE source (D-002), so a commit is attributed even after the editing agent's session
 * ended (which live-presence derivation misses). Each file is attributed to its MOST-RECENT
 * editor within `lookbackHours` (DISTINCT ON (file) ORDER BY ts DESC); rows are then grouped
 * by agent. Best-effort: returns [] on any error so the caller falls back to presence.
 *
 * ⚠ SCOPED BY workspace_id, NOT repo_root (WI-37668) — do NOT "restore" a repo_root filter.
 * The ledger's `repo_root` column is written from the LOCK COORDINATION DOMAIN
 * (locks/identity.ts readIdentity → lockCoordinationDomain()), which resolves to the repo root
 * of whichever OPERATOR PROCESS served the locks:acquire call — NOT the repo the edited files
 * live in. This box serves locks from the release checkout while agents edit the staging tree,
 * so rows land under `…/papercup-release` while git-sync syncs `…/papercusp`. The old
 * `WHERE repo_root = <git-sync's root>` therefore matched ZERO rows and made derived
 * attribution silently inert: measured 2026-08-10, 3,379 rows/24h under the serving root vs 0
 * under the sync root (last row under the sync root: 2026-07-17). Fixing this writer-side is
 * not available — locks:acquire receives already-repo-relative paths and carries no
 * harness/project context, so it cannot know the file's true repo root.
 *
 * DISCRIMINATION is workspace scoping PLUS the caller's dirty-file intersection: git-sync
 * partitions the DIRTY set (git-sync-attribution.buildAttributionGroups), so a roster entry for
 * a file that is not dirty in this repo never matches. Residual risk: two repos in ONE workspace
 * sharing a repo-relative path, both dirty, both edited inside the window, could cross-attribute
 * a trailer. Tighten by also scoping on harness_slug once that column is reliably populated — it
 * is NULL on ~99.6% of rows today because it is joined from the agent's active work-item claim.
 */
export async function readEditAttributionRoster(opts: {
  /** The syncing repo's workspace — the join key. Absent ⇒ [] (unscopable, never read globally). */
  workspaceId: string | null | undefined;
  lookbackHours?: number;
}): Promise<LedgerRosterEntry[]> {
  try {
    const { workspaceId, lookbackHours = 24 } = opts;
    if (!workspaceId) return [];
    const { sql } = getOrgPg();
    const rows = await sql<LedgerRow[]>`
      SELECT DISTINCT ON (file)
             agent_id, file, work_item_id, plan_slug, intent, session_id, contributor,
             extract(epoch FROM ts) * 1000 AS edited_at_ms
        FROM harness_shared.edit_attribution_ledger
       WHERE workspace_id = ${workspaceId}
         AND ts >= now() - make_interval(hours => ${lookbackHours})
       ORDER BY file, ts DESC
    `;
    // One agent can edit different files under different work-items inside the
    // lookback window. Keep those provenance cohorts separate: collapsing only
    // by agent unions an older lane onto newer files and makes git-sync stamp a
    // commit with the wrong Papercusp-Work-Item trailer (EI-21193794700858679).
    const byProvenance = new Map<string, LedgerRosterEntry>();
    for (const r of rows) {
      const key = JSON.stringify([
        r.agent_id,
        r.work_item_id,
        r.plan_slug,
        r.intent,
        r.session_id,
        r.contributor,
      ]);
      let e = byProvenance.get(key);
      if (!e) {
        e = { agent: r.agent_id, files: [], workItems: [] };
        byProvenance.set(key, e);
      }
      const editedAtMs = Number(r.edited_at_ms);
      if (Number.isFinite(editedAtMs)) {
        e.editedAtMsByFile ??= {};
        e.editedAtMsByFile[r.file] = editedAtMs;
      }
      if (!e.files.includes(r.file)) e.files.push(r.file);
      if (r.work_item_id && !e.workItems.includes(r.work_item_id)) e.workItems.push(r.work_item_id);
      // Every row in this cohort has identical scalar provenance.
      if (r.plan_slug && !e.planSlug) e.planSlug = r.plan_slug;
      if (r.intent && !e.intent) e.intent = r.intent;
      if (r.session_id && !e.sessionId) e.sessionId = r.session_id;
      if (r.contributor && !e.contributor) e.contributor = r.contributor;
    }
    return [...byProvenance.values()];
  } catch {
    return [];
  }
}

/** The Papercusp provenance a git-sync per-agent commit carries in its trailers (P-004). */
export interface ParsedCommitAttribution {
  /** The first `Papercusp-Agent:` author. */
  agent?: string;
  /** Every `Papercusp-Agent:` author, when a multi-author commit names more than one. */
  agents?: string[];
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
  const agents: string[] = [];
  for (const raw of (commitBody ?? '').split('\n')) {
    const m = /^(Papercusp-Agent|Papercusp-Work-Item|Papercusp-Session|Papercusp-Plan):\s*(.+)$/.exec(raw.trim());
    if (!m) continue;
    const val = m[2].trim();
    // A multi-author commit (WI-6554700010029864) names several agents; the first is primary.
    if (m[1] === 'Papercusp-Agent') {
      if (!agents.includes(val)) agents.push(val);
      out.agent = agents[0];
      if (agents.length > 1) out.agents = [...agents];
    } else if (m[1] === 'Papercusp-Work-Item') out.workItems = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'Papercusp-Session') out.sessionId = val;
    else if (m[1] === 'Papercusp-Plan') out.planSlug = val;
  }
  return out;
}

/** One git_sync_commit_attribution row — the durable commit→work-item link (P-004). */
export interface CommitAttributionRow {
  workspaceId: string;
  harnessSlug: string;
  /** 'superproject', or the submodule path relative to the top-level superproject; `file` is relative to this repo. */
  repo: string;
  commitSha: string;
  file: string;
  agentId?: string;
  sessionId?: string;
  workItemId?: string;
  planSlug?: string;
  /** Committer date of `commitSha` (ISO 8601). `ts` is when the row was recorded, which can lag by hours. */
  committedAt?: string;
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
        (workspace_id, harness_slug, repo, commit_sha, file, agent_id, session_id, work_item_id, plan_slug, committed_at)
      SELECT * FROM unnest(
        ${rows.map((r) => r.workspaceId)}::text[],
        ${rows.map((r) => r.harnessSlug)}::text[],
        ${rows.map((r) => r.repo)}::text[],
        ${rows.map((r) => r.commitSha)}::text[],
        ${rows.map((r) => r.file)}::text[],
        ${rows.map((r) => r.agentId ?? null)}::text[],
        ${rows.map((r) => r.sessionId ?? null)}::text[],
        ${rows.map((r) => r.workItemId ?? null)}::text[],
        ${rows.map((r) => r.planSlug ?? null)}::text[],
        ${rows.map((r) => r.committedAt ?? null)}::timestamptz[]
      )
    `;
  } catch (error) {
    // best-effort: commit attribution must never affect git-sync — but a silent drop hid
    // an 85h attribution outage once (WI-6554700010018198), so leave a trace.
    console.warn(
      `[edit-attribution] git_sync_commit_attribution insert of ${rows?.length ?? 0} row(s) failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * P-005 (doc-drift attribution): the work-item(s) that recently changed the given CODE files,
 * read back from git_sync_commit_attribution. The doc-freshness sweep calls this for a drifted
 * doc's anchored files so the doc-steward learns WHY the code changed (D-006: derived, no extra
 * agent tool call). Best-effort — returns a `file → workItemIds` map, empty on any error.
 * `lookbackHours` bounds it (default 14 days — the "what recently shaped this code" window).
 */
export async function lookupDriftCauseWorkItems(
  files: string[],
  opts: { harnessSlug?: string; lookbackHours?: number } = {},
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const uniq = [...new Set((files ?? []).filter(Boolean))];
    if (uniq.length === 0) return out;
    const { sql } = getOrgPg();
    const rows = await sql<{ file: string; work_item_id: string }[]>`
      SELECT DISTINCT file, work_item_id
        FROM harness_shared.git_sync_commit_attribution
       WHERE file = ANY(${uniq})
         AND work_item_id IS NOT NULL
         ${opts.harnessSlug ? sql`AND harness_slug = ${opts.harnessSlug}` : sql``}
         AND coalesce(committed_at, ts) >= now() - make_interval(hours => ${opts.lookbackHours ?? 24 * 14})
    `;
    for (const r of rows) {
      const arr = out.get(r.file) ?? [];
      if (!arr.includes(r.work_item_id)) arr.push(r.work_item_id);
      out.set(r.file, arr);
    }
    return out;
  } catch {
    return out;
  }
}
