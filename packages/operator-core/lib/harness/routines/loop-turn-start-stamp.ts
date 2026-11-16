/**
 * loop-turn-start-stamp.ts — the real-time "this loop fire became a turn" signal
 * (EI-24791346664119438).
 *
 * `reconcile-loop-routines` decides whether a delivered loop wake produced a
 * loop turn from `session_turns`, which is INGESTED from transcripts after the
 * turn. Measured 2026-10-02 over 24h: 64 of 334 'delivered-wake-no-loop-turn'
 * settles were real loop turns (loop-fire prompt ~70s after the fire, mean turn
 * 329s) whose rows were ingested 500-600s after the reconciler had already
 * scored the fire an error. Presence could not rescue them: 1 of 64 had any
 * activity in the 60s before the settle (a long silent Bash or text generation
 * is quiet), and the Stop-hook journal only lands at turn END.
 *
 * The turn-start endpoint receives every UserPromptSubmit in real time,
 * including the prompt head that carries the `⟦turn-origin:loop-fire …⟧`
 * envelope. When it does, this module appends one `kind:'lifecycle'` activity
 * row with LOOP_TURN_START_MARKER, which the reconciler reads as
 * `loop_turn_started_at`. Reuses the existing agent_activity store and its
 * TelemetryStore seam: no new table, no migration.
 *
 * Fail-silent by contract: it runs inside the turn-start hook request, whose
 * whole rule is that it must never cost the agent's turn.
 */
import type { ActivityRecord, TelemetryStore } from '@papercusp/activity-bridge';
import type { Sql } from 'postgres';
import { isAbsolute } from 'node:path';
import { activeWorkspaceId } from '../../workspace-registry';
import { LOOP_TURN_START_MARKER, LOOP_TURN_START_SCAN_MARKER } from '../../agent-tools/activity/lifecycle-markers';
import { classify, parseEnvelope, readLedgerRows, TURN_PROVENANCE_DIR, type LedgerRow } from '../../turn-provenance/turn-provenance';

export interface LoopFireIdentity {
  routineId: string;
  wakeCount: number;
}

/** True when the prompt OPENS with a loop-fire turn-origin envelope. Uses the one
 *  shared envelope grammar (`parseEnvelope`), so an envelope quoted mid-text, or
 *  any other origin, never stamps. */
export function isLoopFirePrompt(prompt: string): boolean {
  return parseEnvelope(prompt ?? '')?.origin === 'loop-fire';
}

/** Candidate turn origins; self-compaction still needs authenticated loop lineage. */
export function isLoopTurnStartCandidate(prompt: string): boolean {
  const origin = parseEnvelope(prompt ?? '')?.origin;
  return origin === 'loop-fire' || origin === 'self-compaction';
}

export interface LoopTurnStartInput {
  owner: string;
  prompt: string;
  workspaceId: string;
  cwd?: string | null;
  client?: string | null;
  /** Opaque hook request id for joining this marker to its turn-start receipt. */
  turnStartRequestId?: string | null;
  /** Resolved identity; the async recorder binds production lookups to the launch ledger. */
  loopFire?: LoopFireIdentity | null;
}

/** Resolve the typed loop identity enrolled alongside the prompt's provenance nonce.
 *  A missing/expired/malformed row is deliberately unknown: reconciliation keeps its
 *  bounded legacy retry path instead of guessing from wake text or timestamps. */
export function resolveLoopFireIdentity(
  owner: string, prompt: string, dir: string, nowMs = Date.now(),
): LoopFireIdentity | null {
  const envelope = parseEnvelope(prompt ?? '');
  if (!envelope || !['loop-fire', 'self-compaction'].includes(envelope.origin)) return null;
  const row = readLedgerRows(owner, { includeExpired: false, dir, nowMs })
    .find((candidate) => candidate.nonce === envelope.nonce);
  if (!row || row.sid !== owner || row.origin !== envelope.origin || !Number.isFinite(row.ts) || row.ts > nowMs ||
      typeof row.loopFire?.routineId !== 'string' || !row.loopFire.routineId.trim() ||
      !Number.isInteger(row.loopFire.wakeCount) || row.loopFire.wakeCount <= 0) return null;
  return {
    routineId: row.loopFire.routineId,
    wakeCount: row.loopFire.wakeCount,
  };
}

/** Resolve a turn identity using a launch-pinned directory, or the canonical
 * operator ledger for legacy launch rows created before that pin was recorded.
 * A custom directory is usable only when persisted on the launch record; cwd and
 * request-provided environment values never select the ledger.
 */
export function resolveLoopFireIdentityForLaunch(
  input: { owner: string; prompt: string; workspaceId: string; client?: string | null },
  launch: { workspaceId?: unknown; agent?: unknown; launchSpec?: unknown } | null,
  options: { fallbackDir?: string; nowMs?: number } = {},
): LoopFireIdentity | null {
  const owner = input.owner?.trim();
  if (!owner || !launch || launch.workspaceId !== input.workspaceId) return null;
  const spec = launch.launchSpec && typeof launch.launchSpec === 'object'
    ? launch.launchSpec as Record<string, unknown> : null;
  if (!spec || spec.workspaceId !== input.workspaceId ||
      (input.client && launch.agent !== input.client)) return null;
  const pinnedDir = spec.turnProvenanceDir;
  const dir = typeof pinnedDir === 'string' && isAbsolute(pinnedDir)
    ? pinnedDir
    : options.fallbackDir ?? TURN_PROVENANCE_DIR;
  if (!isAbsolute(dir)) return null;
  return resolveLoopFireIdentity(owner, input.prompt, dir, options.nowMs);
}

function isValidLoopFireIdentity(value: unknown): value is LoopFireIdentity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LoopFireIdentity>;
  return typeof candidate.routineId === 'string' && candidate.routineId.trim().length > 0 &&
    typeof candidate.wakeCount === 'number' && Number.isInteger(candidate.wakeCount) && candidate.wakeCount > 0;
}

/** Read the authenticated loop identity for the exact latest prompt in a live
 *  session. This is used only before managed self-compaction: carrying an
 *  identity requires both the persisted prompt origin and its matching
 *  UserPromptSubmit start marker. Presence, active-loop state, and prompt prose
 *  alone never grant continuation lineage. */
export async function readLoopFireIdentityForCurrentTurn(
  input: { owner: string; sessionId: string; sourceKind: string },
  opts: { sql: Sql },
): Promise<LoopFireIdentity | null> {
  const owner = input.owner?.trim();
  if (!owner || !input.sessionId?.trim() || !input.sourceKind?.trim()) return null;
  try {
    const turns = await opts.sql<Array<{
      turn_idx: number;
      text: string;
      turn_origin: string | null;
      turn_origin_verdict: string | null;
    }>>`
      SELECT turn_idx, text, turn_origin, turn_origin_verdict
        FROM harness_shared.session_turns
       WHERE owner = ${owner}
         AND source_kind = ${input.sourceKind}
         AND session_id = ${input.sessionId}
         AND speaker = 'user'
       ORDER BY turn_idx DESC
       LIMIT 1`;
    const turn = turns[0];
    if (!turn || turn.turn_origin_verdict !== 'agent-injected') return null;
    const envelope = parseEnvelope(turn.text ?? '');
    if (!envelope || !['loop-fire', 'self-compaction'].includes(envelope.origin) ||
        turn.turn_origin !== envelope.origin) return null;

    const markers = await opts.sql<Array<{ detail: unknown }>>`
      SELECT detail
        FROM harness_shared.agent_activity
       WHERE owner_id = ${owner}
         AND kind = 'lifecycle'
         AND summary = ${LOOP_TURN_START_MARKER}
         AND detail->>'nonce' = ${envelope.nonce}
         AND detail->>'origin' = ${envelope.origin}
         AND detail->>'source' IN ('turn-start', 'session-ingest')
       ORDER BY created_at DESC
       LIMIT 5`;
    for (const marker of markers) {
      const detail = marker.detail && typeof marker.detail === 'object'
        ? marker.detail as Record<string, unknown>
        : null;
      if (!detail || detail.nonce !== envelope.nonce || detail.origin !== envelope.origin) continue;
      if (detail.source === 'session-ingest') {
        const indexedTurn = detail.indexedTurn && typeof detail.indexedTurn === 'object'
          ? detail.indexedTurn as Record<string, unknown>
          : null;
        if (indexedTurn?.sourceKind !== input.sourceKind ||
            indexedTurn.sessionId !== input.sessionId ||
            indexedTurn.turnIdx !== turn.turn_idx) continue;
      }
      if (isValidLoopFireIdentity(detail.loopFire)) return detail.loopFire;
    }
  } catch {
    // A missing or unreadable proof keeps the existing fail-closed behavior.
  }
  return null;
}

/** Build the activity row for a loop-fire turn start, or null when the prompt is
 *  not a loop-fire turn. Pure: the route test and the reconciler both rely on the
 *  summary being EXACTLY LOOP_TURN_START_MARKER. */
export function loopTurnStartRecord(input: LoopTurnStartInput): ActivityRecord | null {
  const owner = (input.owner ?? '').trim();
  const envelope = parseEnvelope(input.prompt);
  const loopFire = input.loopFire;
  const directLoopFire = envelope?.origin === 'loop-fire';
  const verifiedCompactionContinuation = envelope?.origin === 'self-compaction' &&
    isValidLoopFireIdentity(loopFire);
  if (!owner || (!directLoopFire && !verifiedCompactionContinuation)) return null;
  return {
    owner,
    agent: input.client || null,
    sessionId: null,
    scope: null,
    kind: 'lifecycle',
    toolName: null,
    phase: null,
    toolUseId: null,
    summary: LOOP_TURN_START_MARKER,
    status: null,
    detail: envelope
      ? {
          origin: envelope.origin,
          nonce: envelope.nonce,
          source: 'turn-start',
          ...(typeof input.turnStartRequestId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(input.turnStartRequestId)
            ? { turnStartRequestId: input.turnStartRequestId }
            : {}),
          ...(loopFire ? { loopFire } : {}),
        }
      : null,
    cwd: input.cwd ?? null,
    workspaceId: input.workspaceId,
  };
}

/** Append the stamp when the prompt is a loop-fire turn. Never throws; returns
 *  whether a row was appended (for tests and diagnostics). */
export async function recordLoopTurnStart(
  input: LoopTurnStartInput,
  store?: Pick<TelemetryStore, 'append'>,
): Promise<boolean | null> {
  const owner = input.owner?.trim();
  const envelope = parseEnvelope(input.prompt);
  if (!owner || !envelope || !['loop-fire', 'self-compaction'].includes(envelope.origin)) return null;
  const submittedAt = Date.now();
  try {
    let loopFire = input.loopFire;
    // A continuation must always resolve from its own server-written ledger row;
    // a caller-supplied identity cannot upgrade a self-compaction prompt.
    if (loopFire === undefined || envelope.origin === 'self-compaction') {
      loopFire = null;
      try {
        const { readAdvSessionLaunchRecordByOwner } = await import('../../adv-sessions');
        const launch = await readAdvSessionLaunchRecordByOwner(owner, input.workspaceId);
        // The hook and ingest host can serve several namespaces. A persisted launch
        // pin selects a custom ledger; legacy rows may consult only the canonical
        // operator directory, never cwd or request-provided environment values.
        loopFire = resolveLoopFireIdentityForLaunch({
          owner,
          prompt: input.prompt,
          workspaceId: input.workspaceId,
          client: input.client,
        }, launch, { nowMs: submittedAt });
      } catch {
        // Unavailable, expired, or missing ledger proof stays unknown, retaining only the generic stamp.
      }
    }
    const record = loopTurnStartRecord({ ...input, owner, loopFire });
    if (!record) return null;
    const target = store ?? (await import('../../activity-pg-store')).createPgTelemetryStore();
    await target.append(record);
    return true;
  } catch {
    return false;
  }
}

/** Only persisted native transcript rows may enter this producer. */
export interface IndexedNativeLoopTurn {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  turn_idx: number;
  ts: string | Date | null;
  owner: string | null;
  speaker: string;
  text: string;
  turn_origin?: string | null;
  harness_slug?: string | null;
  cwd?: string | null;
}

/** Validate enrollment at submission, rather than at this later ingest. The nonce
 * is authoritative; a transit-mangled payload is still admitted. Missing ledger
 * history stays unknown and never upgrades native owner-authentication evidence. */
export function indexedLoopTurnStartRecord(
  turn: IndexedNativeLoopTurn,
  ledgerRows?: LedgerRow[],
  target?: { dir: string; workspaceId: string },
): ActivityRecord | null {
  const owner = turn.owner?.trim();
  const submittedAt = turn.ts === null ? NaN : new Date(turn.ts).getTime();
  const envelope = parseEnvelope(turn.text);
  const supportedOrigin = (turn.turn_origin === 'loop-fire' && envelope?.origin === 'loop-fire') ||
    (turn.turn_origin === 'self-compaction' && envelope?.origin === 'self-compaction');
  if (!owner || turn.speaker !== 'user' || !supportedOrigin ||
      !['claude', 'codex', 'omp'].includes(turn.source_kind) ||
      !turn.workspace_id || !turn.session_id || !Number.isInteger(turn.turn_idx) || turn.turn_idx < 0 ||
      !Number.isFinite(submittedAt)) return null;
  // Native transcript rows use the corpus namespace 'default'; it is not the
  // target workspace. Explicit non-corpus namespaces must match the launch.
  if (target && turn.workspace_id !== 'default' && turn.workspace_id !== target.workspaceId) return null;
  const rows = ledgerRows ?? readLedgerRows(owner, { nowMs: submittedAt, dir: target?.dir });
  const enrollment = rows.find(row => row.nonce === envelope.nonce);
  if (!enrollment || enrollment.sid !== owner || enrollment.origin !== envelope.origin ||
      !Number.isFinite(enrollment.ts) || enrollment.ts > submittedAt ||
      typeof enrollment.loopFire?.routineId !== 'string' || !enrollment.loopFire.routineId.trim() ||
      !Number.isInteger(enrollment.loopFire.wakeCount) || enrollment.loopFire.wakeCount <= 0 ||
      classify(turn.text, [enrollment], { nowMs: submittedAt }).verdict !== 'verified-agent') return null;
  const record = loopTurnStartRecord({
    owner, workspaceId: turn.workspace_id, prompt: turn.text,
    client: turn.source_kind, cwd: turn.cwd, loopFire: enrollment.loopFire,
  });
  if (!record) return null;
  return {
    ...record,
    sessionId: turn.session_id,
    scope: turn.harness_slug ?? null,
    detail: {
      ...record.detail,
      source: 'session-ingest',
      ...(target ? { provenanceWorkspaceId: target.workspaceId } : {}),
      indexedTurn: {
        workspaceId: turn.workspace_id,
        sourceKind: turn.source_kind,
        sessionId: turn.session_id,
        turnIdx: turn.turn_idx,
      },
    },
  };
}

export interface IndexedLoopLaunchBinding {
  owner: string;
  workspace_id: string;
  agent: string;
  session_id: string | null;
  omp_thread_id: string | null;
  spec_workspace: string | null;
  provenance_dir: string | null;
}

/** An ADV launch receipt selects the ledger. Legacy launches without a pin use
 * the canonical ledger, as the real-time hook does; caller environment and cwd
 * never select it. Missing or ambiguous launch identities remain unknown. */
export function indexedLoopLaunchBinding(
  turn: IndexedNativeLoopTurn,
  launches: IndexedLoopLaunchBinding[],
  workspaceId: string,
  canonicalDir: string = TURN_PROVENANCE_DIR,
): { dir: string; workspaceId: string } | null {
  const matches = launches.filter(row => row.owner === turn.owner &&
    row.workspace_id === workspaceId && row.spec_workspace === workspaceId &&
    row.agent === turn.source_kind &&
    (row.agent === 'omp' ? row.omp_thread_id : row.session_id) === turn.session_id);
  if (matches.length !== 1) return null;
  const dir = matches[0]!.provenance_dir ?? canonicalDir;
  if (!isAbsolute(dir)) return null;
  return { dir, workspaceId };
}

export async function recordIndexedLoopTurnStarts(sql: Sql, turns: IndexedNativeLoopTurn[]): Promise<void> {
  const candidates = turns.filter(turn => turn.owner && turn.speaker === 'user' &&
    ['loop-fire', 'self-compaction'].includes(turn.turn_origin ?? '') &&
    ['claude', 'codex', 'omp'].includes(turn.source_kind));
  if (!candidates.length) return;
  const workspaceId = activeWorkspaceId();
  const owners = [...new Set(candidates.map(turn => turn.owner!))];
  const sessions = [...new Set(candidates.map(turn => turn.session_id))];
  const launches = await sql<IndexedLoopLaunchBinding[]>`
    SELECT a.coord_owner_id AS owner, a.workspace_id, a.agent, a.session_id, a.omp_thread_id,
           a.launch_spec->>'workspaceId' AS spec_workspace,
           a.launch_spec->>'turnProvenanceDir' AS provenance_dir
      FROM harness_shared.adv_sessions a
     WHERE a.workspace_id = ${workspaceId}
       AND a.coord_owner_id = ANY(${sql.array(owners)}::text[])
       AND (a.session_id = ANY(${sql.array(sessions)}::text[])
         OR a.omp_thread_id = ANY(${sql.array(sessions)}::text[]))
    UNION
    -- A managed resume re-anchors the mutable ADV row to the successor. The
    -- applied identity ledger retains the exact predecessor/native binding.
    SELECT a.coord_owner_id AS owner, a.workspace_id, a.agent,
           s.native_session_id AS session_id,
           CASE WHEN a.agent = 'omp' THEN s.native_session_id ELSE a.omp_thread_id END AS omp_thread_id,
           a.launch_spec->>'workspaceId' AS spec_workspace,
           a.launch_spec->>'turnProvenanceDir' AS provenance_dir
      FROM harness_shared.adv_sessions a
      JOIN harness_shared.session_identity_activation_spans s
        ON s.adv_session_id = a.id
       AND s.workspace_id = a.workspace_id
       AND s.owner_id = a.coord_owner_id
     WHERE a.workspace_id = ${workspaceId}
       AND a.coord_owner_id = ANY(${sql.array(owners)}::text[])
       AND s.native_session_id = ANY(${sql.array(sessions)}::text[])
  `;
  const records = candidates.flatMap(turn => {
    const target = indexedLoopLaunchBinding(turn, launches, workspaceId);
    const record = target ? indexedLoopTurnStartRecord(turn, undefined, target) : null;
    return record ? [record] : [];
  });
  if (!records.length) return;
  const { createPgTelemetryStore } = await import('../../activity-pg-store');
  // Reuse the ingest client and its statement-timeout budget. In particular, do
  // not use the hook adapter's default global connection or backdate created_at.
  const store = createPgTelemetryStore(sql);
  for (const record of records) await store.append(record);
}

interface IndexedLoopScanPosition {
  turnIdx: number;
  workspaceId: string;
}

export interface IndexedLoopTurnStartRefresh {
  inspected: number;
  hasMore: boolean;
  resumeBefore: IndexedLoopScanPosition | null;
}

/** Read-time refresh also repairs turns indexed before their marker producer or
 * launch receipt was available. Reuse the activity ledger for scan progress,
 * separate from authenticated start markers. Each transaction consumes at most
 * 64 candidates and commits its cursor with the proof writes. The next refresh
 * resumes below rejected candidates even after a process restart; reaching the
 * end resets the cursor so late enrollment/launch evidence is retried. */
export async function reconcileIndexedLoopTurnStarts(
  sql: Sql,
  input: { owner: string; sourceKind: string; sessionId: string },
): Promise<IndexedLoopTurnStartRefresh | null> {
  if (!input.owner || !input.sessionId || !['claude', 'codex', 'omp'].includes(input.sourceKind)) return null;
  const workspaceId = activeWorkspaceId();
  const reconcile = async (client: Sql): Promise<IndexedLoopTurnStartRefresh> => {
    // Serialize cursor consumption as well as proof writes. SKIP LOCKED with a
    // moving cursor would jump over a locked candidate without inspecting it.
    await client`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
      LOOP_TURN_START_SCAN_MARKER, workspaceId, input.owner, input.sourceKind, input.sessionId,
    ])}, 0))`;
    const checkpoints = await client<Array<{ detail: { resumeBefore?: IndexedLoopScanPosition | null } }>>`
      SELECT detail FROM harness_shared.agent_activity
       WHERE workspace_id = ${workspaceId} AND owner_id = ${input.owner}
         AND agent = ${input.sourceKind} AND session_id = ${input.sessionId}
         AND kind = 'lifecycle' AND summary = ${LOOP_TURN_START_SCAN_MARKER}
       ORDER BY id DESC LIMIT 1`;
    const saved = checkpoints[0]?.detail?.resumeBefore;
    const before = saved && Number.isSafeInteger(saved.turnIdx) && saved.turnIdx >= 0 &&
      ['default', workspaceId].includes(saved.workspaceId) ? saved : null;
    const turns = await client<IndexedNativeLoopTurn[]>`
      SELECT st.workspace_id, st.source_kind, st.session_id, st.turn_idx, st.ts,
             st.owner, st.harness_slug, st.cwd, st.speaker, st.text, st.turn_origin
        FROM harness_shared.session_turns st
       WHERE st.workspace_id IN ('default', ${workspaceId})
         AND st.source_kind = ${input.sourceKind}
         AND st.session_id = ${input.sessionId}
         AND st.owner = ${input.owner}
         AND st.speaker = 'user'
         AND st.turn_origin IN ('loop-fire', 'self-compaction')
         AND (${before === null} OR
           (st.turn_idx, st.workspace_id) < (${before?.turnIdx ?? 0}, ${before?.workspaceId ?? ''}))
         AND NOT EXISTS (
           SELECT 1 FROM harness_shared.agent_activity activity
            WHERE activity.workspace_id = st.workspace_id
              AND activity.owner_id = st.owner
              AND activity.summary = ${LOOP_TURN_START_MARKER}
              AND activity.detail->'indexedTurn' = jsonb_build_object(
                'workspaceId', st.workspace_id, 'sourceKind', st.source_kind,
                'sessionId', st.session_id, 'turnIdx', st.turn_idx)
         )
       ORDER BY st.turn_idx DESC, st.workspace_id DESC
       LIMIT 65
       FOR UPDATE OF st
    `;
    // The extra candidate signals recoverable omission; its complete source
    // remains in session_turns and is selected by the next persisted cursor.
    const batch = turns.slice(0, 64);
    const last = batch.at(-1);
    const result: IndexedLoopTurnStartRefresh = {
      inspected: batch.length,
      hasMore: turns.length > batch.length,
      resumeBefore: turns.length > batch.length && last
        ? { turnIdx: last.turn_idx, workspaceId: last.workspace_id } : null,
    };
    await recordIndexedLoopTurnStarts(client, batch);
    if (batch.length || before) {
      const { createPgTelemetryStore } = await import('../../activity-pg-store');
      await createPgTelemetryStore(client).append({
        owner: input.owner, agent: input.sourceKind, sessionId: input.sessionId,
        workspaceId, scope: null, kind: 'lifecycle', toolName: null, phase: null,
        toolUseId: null, summary: LOOP_TURN_START_SCAN_MARKER, status: null,
        detail: { schemaVersion: 1, ...result }, cwd: null,
      });
    }
    return result;
  };
  if (typeof sql.begin === 'function') return await sql.begin(tx => reconcile(tx as unknown as Sql));
  return await reconcile(sql);
}
