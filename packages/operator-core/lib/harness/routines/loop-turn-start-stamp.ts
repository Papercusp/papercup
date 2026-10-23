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
import { LOOP_TURN_START_MARKER } from '../../agent-tools/activity/lifecycle-markers';
import { classify, parseEnvelope, readLedgerRows, type LedgerRow } from '../../turn-provenance/turn-provenance';

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

export interface LoopTurnStartInput {
  owner: string;
  prompt: string;
  workspaceId: string;
  cwd?: string | null;
  client?: string | null;
  /** Optional test seam; production resolves this from the provenance ledger nonce. */
  loopFire?: LoopFireIdentity | null;
}

/** Resolve the typed loop identity enrolled alongside the prompt's provenance nonce.
 *  A missing/expired/malformed row is deliberately unknown: reconciliation keeps its
 *  bounded legacy retry path instead of guessing from wake text or timestamps. */
export function resolveLoopFireIdentity(owner: string, prompt: string): LoopFireIdentity | null {
  const envelope = parseEnvelope(prompt ?? '');
  if (!envelope || envelope.origin !== 'loop-fire') return null;
  const row = readLedgerRows(owner, { includeExpired: false }).find((candidate) => candidate.nonce === envelope.nonce);
  if (!row?.loopFire) return null;
  return {
    routineId: row.loopFire.routineId,
    wakeCount: row.loopFire.wakeCount,
  };
}

/** Build the activity row for a loop-fire turn start, or null when the prompt is
 *  not a loop-fire turn. Pure: the route test and the reconciler both rely on the
 *  summary being EXACTLY LOOP_TURN_START_MARKER. */
export function loopTurnStartRecord(input: LoopTurnStartInput): ActivityRecord | null {
  const owner = (input.owner ?? '').trim();
  if (!owner || !isLoopFirePrompt(input.prompt)) return null;
  const envelope = parseEnvelope(input.prompt);
  const loopFire = input.loopFire === undefined ? resolveLoopFireIdentity(owner, input.prompt) : input.loopFire;
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
): Promise<boolean> {
  const record = loopTurnStartRecord(input);
  if (!record) return false;
  try {
    const target = store ?? (await import('../../activity-pg-store')).createPgTelemetryStore();
    await target.append(record);
    return true;
  } catch {
    return false;
  }
}

/** Only rows returned by the normal transcript INSERT may enter this producer. */
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
): ActivityRecord | null {
  const owner = turn.owner?.trim();
  const submittedAt = turn.ts === null ? NaN : new Date(turn.ts).getTime();
  if (!owner || turn.speaker !== 'user' || turn.turn_origin !== 'loop-fire' ||
      !['claude', 'codex', 'omp'].includes(turn.source_kind) ||
      !turn.workspace_id || !turn.session_id || !Number.isInteger(turn.turn_idx) || turn.turn_idx < 0 ||
      !Number.isFinite(submittedAt)) return null;
  const envelope = parseEnvelope(turn.text);
  if (envelope?.origin !== 'loop-fire') return null;
  const rows = ledgerRows ?? readLedgerRows(owner, { nowMs: submittedAt });
  const enrollment = rows.find(row => row.nonce === envelope.nonce);
  if (!enrollment || enrollment.sid !== owner || enrollment.origin !== 'loop-fire' ||
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
      indexedTurn: {
        workspaceId: turn.workspace_id,
        sourceKind: turn.source_kind,
        sessionId: turn.session_id,
        turnIdx: turn.turn_idx,
      },
    },
  };
}

export async function recordIndexedLoopTurnStarts(sql: Sql, turns: IndexedNativeLoopTurn[]): Promise<void> {
  const records = turns.map(turn => indexedLoopTurnStartRecord(turn)).filter(record => record !== null);
  if (!records.length) return;
  const { createPgTelemetryStore } = await import('../../activity-pg-store');
  // Reuse the ingest client and its statement-timeout budget. In particular, do
  // not use the hook adapter's default global connection or backdate created_at.
  const store = createPgTelemetryStore(sql);
  for (const record of records) await store.append(record);
}
