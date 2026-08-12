/**
 * Mode store — reads/writes harness_shared.agent_modes (+ the append-only
 * agent_mode_changes audit) with the axis semantics enforced at the write
 * (modes-and-intake-ux-2026-07-05 P-006, D-003, D-006).
 *
 * Semantics enforced HERE (not in the tool layer), so every caller gets them:
 *   - AUTO-SWITCH: setting a mode replaces the same-axis incumbent in one
 *     upsert (PK (workspace_id, owner_id, axis_key)); the displaced mode is
 *     returned as `switchedFrom` and audited as its own transition.
 *   - OWNER-STICKY (D-003): a row with owner_directed=true can only be
 *     changed by its own agent (self) or an owner-directed write; a peer's
 *     attempt returns { stickyConflict: true } and writes NOTHING — the tool
 *     layer downgrades it to a request message.
 *   - AUDIT: every applied transition (set / clear / auto-switch displacement)
 *     appends an agent_mode_changes row.
 *
 * Injectable `sql` seam for unit tests (same discipline as the rest of the
 * coordination layer: pure logic testable without PG).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { modeById, axisKeyFor, resolveImpliedModes, modeRequiresSubject, type ModeDef } from './registry';
import { notifyAgentOrdersChanged } from '../agent-orders-notify';

export interface ModeRow {
  workspaceId: string;
  ownerId: string;
  axisKey: string;
  mode: string;
  reason: string;
  setBy: string;
  ownerDirected: boolean;
  setAt: string;
  /**
   * WHAT this mode is about — mode-defined and optional (migration 767,
   * goal-mode-2026-08-07 P-016). GOAL stores the `harness_shared.goals.id` the
   * session is running, which is how goal provenance is stamped from SESSION
   * CONTEXT rather than agent self-report. Deliberately generic: DRAIN's scope
   * or GRADE's rubric ref fit the same slot, which is why this is not named
   * `goalId` and is not a foreign key. A dangling value must degrade to "no
   * stamp", never to a failed write.
   */
  subject: string | null;
}

export interface SetModeOpts {
  workspaceId: string;
  /** The agent whose mode changes. */
  ownerId: string;
  modeId: string;
  /** false ⇒ exit the mode (clear its row if currently set). */
  enabled: boolean;
  reason: string;
  /** The caller (self-set when === ownerId). */
  setBy: string;
  /** The human owner explicitly instructed this — arms the sticky flag. */
  ownerDirected?: boolean;
  /**
   * The CALLER is a verified owner-authority channel even though this is a
   * peer-set (setBy !== ownerId) — e.g. the human's admin coord/mode UI
   * acting on the owner's behalf to set a mode on the agent session they're
   * chatting with (gui-chat-session-controls-2026-07-25 P-003/P-004). Set
   * ONLY by the tool layer after verifying the caller identity — never
   * derived from client-supplied args. Self-set already carries owner
   * authority implicitly; this widens it to that one additional verified
   * channel, not to arbitrary agent peers.
   */
  callerIsOwnerAuthority?: boolean;
  /**
   * WHAT this mode is about — see ModeRow.subject. Tri-state on purpose:
   *   undefined → leave the incumbent's subject untouched (a reason-only
   *               refresh must not silently erase which goal is running);
   *   null      → clear it explicitly;
   *   string    → set it.
   * Ignored when `enabled: false`, since clearing a mode deletes the row and
   * the subject cannot outlive the mode it parameterises.
   */
  subject?: string | null;
  sql?: Sql;
}

/**
 * What the cascade did about ONE implied mode (D-003).
 *
 * Four outcomes, all reported rather than any being silent, because the whole
 * point of the mechanism is that the agent can SEE what it now holds:
 *   - `set`        — the axis was empty and this mode now occupies it;
 *   - `already-on` — the agent was already in it (an idempotent re-entry);
 *   - `axis-held`  — a DIFFERENT mode holds that axis and was left alone
 *                    (`by` names it: cold-auto satisfies "implies auto", and
 *                    replacing it with plain auto would be a downgrade nobody
 *                    asked for);
 *   - `skipped`    — refused on purpose; `error` says why.
 *   - `failed`     — the write errored; `error` carries it.
 */
export type ImpliedModeStatus = 'set' | 'already-on' | 'axis-held' | 'skipped' | 'failed';

export interface ImpliedModeOutcome {
  mode: string;
  status: ImpliedModeStatus;
  /** The mode occupying that axis instead — only on `axis-held`. */
  by?: string;
  error?: string;
}

export interface SetModeResult {
  ok: boolean;
  /** The write was refused because the incumbent is owner-directed and the caller is a peer. */
  stickyConflict?: boolean;
  /** The same-axis mode that was displaced by this set (auto-switch, D-006). */
  switchedFrom?: string | null;
  /** True when the write changed nothing (already in / already out). */
  noop?: boolean;
  mode?: ModeDef;
  /**
   * The modes this one IMPLIES and what became of each (D-003). Present on any
   * successful ENABLE of a mode that declares `implies` — including a `noop`
   * re-entry, which is deliberately how a missing implied row gets REPAIRED.
   */
  implied?: ImpliedModeOutcome[];
  error?: string;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

function toRow(r: Record<string, unknown>): ModeRow {
  return {
    workspaceId: String(r.workspace_id),
    ownerId: String(r.owner_id),
    axisKey: String(r.axis_key),
    mode: String(r.mode),
    reason: String(r.reason ?? ''),
    setBy: String(r.set_by ?? ''),
    ownerDirected: Boolean(r.owner_directed),
    setAt: r.set_at instanceof Date ? r.set_at.toISOString() : String(r.set_at),
    subject: r.subject == null || r.subject === '' ? null : String(r.subject),
  };
}

/**
 * The subject of one specific mode, or null when the agent is not in it —
 * the read half of ModeRow.subject.
 *
 * Returns null rather than throwing for every "not applicable" case (unknown
 * mode id, not in the mode, in it with no subject) because every caller is a
 * STAMPING path: the correct behaviour when provenance cannot be resolved is
 * to write no stamp, never to fail the creation the stamp was decorating.
 */
export async function getModeSubject(
  workspaceId: string,
  ownerId: string,
  modeId: string,
  sql?: Sql,
): Promise<string | null> {
  const def = modeById(modeId);
  if (!def || !workspaceId || !ownerId) return null;
  const rows = await pg(sql)`
    SELECT subject FROM harness_shared.agent_modes
    WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
      AND axis_key = ${axisKeyFor(def)} AND mode = ${def.id}
    LIMIT 1`;
  const raw = rows.length ? (rows[0] as { subject?: unknown }).subject : null;
  return raw == null || raw === '' ? null : String(raw);
}

/** Current modes for one agent. */
export async function getModes(workspaceId: string, ownerId: string, sql?: Sql): Promise<ModeRow[]> {
  const rows = await pg(sql)`
    SELECT * FROM harness_shared.agent_modes
    WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
    ORDER BY axis_key`;
  return rows.map(toRow);
}

/** Current modes for many agents in one round-trip — the presence/orient fan-in. */
export async function getModesForOwners(
  workspaceId: string,
  ownerIds: readonly string[],
  sql?: Sql,
): Promise<Map<string, ModeRow[]>> {
  const out = new Map<string, ModeRow[]>();
  if (!ownerIds.length) return out;
  const rows = await pg(sql)`
    SELECT * FROM harness_shared.agent_modes
    WHERE workspace_id = ${workspaceId} AND owner_id IN ${pg(sql)(ownerIds as string[])}
    ORDER BY axis_key`;
  for (const r of rows) {
    const row = toRow(r);
    const list = out.get(row.ownerId) ?? [];
    list.push(row);
    out.set(row.ownerId, list);
  }
  return out;
}

async function audit(
  sql: Sql,
  o: { workspaceId: string; ownerId: string; axisKey: string; oldMode: string | null; newMode: string | null; reason: string; setBy: string; ownerDirected: boolean },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_mode_changes
      (workspace_id, owner_id, axis_key, old_mode, new_mode, reason, set_by, owner_directed)
    VALUES (${o.workspaceId}, ${o.ownerId}, ${o.axisKey}, ${o.oldMode}, ${o.newMode},
            ${o.reason}, ${o.setBy}, ${o.ownerDirected})`;
}

/**
 * ── THE IMPLICATION CASCADE (D-003) ─────────────────────────────────────────
 *
 * [owner 2026-08-10, interactive: "make sure goal mode implies both auto and
 * ideate mode. Does that need to be added to the prompt or just part of the
 * system?"] — Both, but THIS is the real fix. The contract used to end with
 * "GOAL implies AUTO: if the autonomy axis is empty, also mode:set auto", i.e. an
 * instruction to the agent to perform a second call. A directive that depends on
 * an agent remembering to call a tool is exactly what gets dropped at a
 * compaction — and every guard downstream (`modeImpliesAutonomy`) meanwhile
 * treated the session as autonomous whether or not the row was ever written.
 *
 * WHY IT LIVES IN THE STORE AND NOT IN THE `mode:set` TOOL. Three doors enter a
 * mode — the tool, `goals:start` (which mints a GOAL agent before it is even
 * spawned), and `bootstrap-su.syncLaunchModeToRegistry` (the launch-flag sync) —
 * and only one of them is the tool. Putting the cascade one layer down means a
 * door cannot forget it, the same structural argument P-004's launch resolver
 * won: the reliable mechanism is the one no caller has to remember.
 *
 * FILL AN EMPTY AXIS, NEVER DISPLACE. Expressed as a single INSERT … ON CONFLICT
 * DO NOTHING rather than a read-then-`setMode`, for two reasons that are both
 * about correctness, not brevity:
 *   - ATOMIC. A check-then-write races another writer through the gap, and the
 *     ordinary upsert would then DISPLACE what it found. DO NOTHING cannot.
 *   - SEMANTICALLY DIFFERENT from `setMode`. "Enter this mode, replacing the
 *     same-axis incumbent" and "adopt this mode only if that axis is free" are
 *     genuinely different operations. cold-auto already satisfies "implies
 *     auto"; overwriting it with plain auto would silently downgrade a posture
 *     the agent (or owner) deliberately chose.
 *
 * NOT MIRRORED ON EXIT, on purpose. Leaving GOAL does not clear auto/ideate: the
 * agent may well have been in AUTO before it ever entered GOAL, and revoking a
 * posture the owner set independently is a destructive guess. The implication is
 * "entering this means entering those", not "these belong to me".
 */
async function applyImpliedModes(
  sql: Sql,
  o: {
    workspaceId: string;
    ownerId: string;
    modeId: string;
    reason: string;
    setBy: string;
  },
): Promise<ImpliedModeOutcome[]> {
  const out: ImpliedModeOutcome[] = [];
  for (const id of resolveImpliedModes(o.modeId)) {
    const def = modeById(id);
    if (!def) continue; // unreachable — resolveImpliedModes drops unknown ids
    /* A mode that is ABOUT something cannot be implied: the cascade has no
       subject to give it, and entering it unattributed is the exact silent
       zeroing EI-20015592992797890 documents (work_items.goal_id stops stamping
       while every surface still looks healthy). Refuse loudly instead. The
       registry test asserts no such declaration exists, so this is the belt to
       that braces. */
    if (modeRequiresSubject(def.id)) {
      out.push({
        mode: def.id,
        status: 'skipped',
        error: `'${def.id}' requires a subject, which an implication cannot supply — declare it explicitly, not via implies`,
      });
      continue;
    }
    const axisKey = axisKeyFor(def);
    const reason = `implied by '${o.modeId}' — ${o.reason}`;
    /* An implied row is DERIVED posture, not a second owner instruction. The
       triggering mode may be owner-directed, but copying that bit would claim
       the owner explicitly directed every mode in the cascade and would arm
       the owner-sticky guard on rows the owner never named. */
    const impliedOwnerDirected = false;
    try {
      const inserted = await sql`
        INSERT INTO harness_shared.agent_modes
          (workspace_id, owner_id, axis_key, mode, reason, set_by, owner_directed, set_at, subject)
        VALUES (${o.workspaceId}, ${o.ownerId}, ${axisKey}, ${def.id}, ${reason},
                ${o.setBy}, ${impliedOwnerDirected}, now(), ${null})
        ON CONFLICT (workspace_id, owner_id, axis_key) DO NOTHING
        RETURNING mode`;
      if (inserted.length) {
        // Audited like any other transition: an implied entry is a real posture
        // change and must be as traceable as a hand-set one — "who put this
        // agent in AUTO" has to answer "the goal cascade", not nothing.
        await audit(sql, {
          workspaceId: o.workspaceId, ownerId: o.ownerId, axisKey,
          oldMode: null, newMode: def.id, reason, setBy: o.setBy, ownerDirected: impliedOwnerDirected,
        });
        out.push({ mode: def.id, status: 'set' });
        continue;
      }
      // The axis was already occupied. Read WHO for the report only — the write
      // decision above was already made atomically, so this cannot race into a
      // wrong action, only into a slightly stale label.
      const held = await sql`
        SELECT mode FROM harness_shared.agent_modes
        WHERE workspace_id = ${o.workspaceId} AND owner_id = ${o.ownerId} AND axis_key = ${axisKey}
        LIMIT 1`;
      const by = held.length ? String((held[0] as { mode: unknown }).mode) : null;
      out.push(
        by && by !== def.id
          ? { mode: def.id, status: 'axis-held', by }
          : { mode: def.id, status: 'already-on' },
      );
    } catch (e) {
      /* Fail-SOFT but LOUD. The primary mode change already landed and is
         audited; failing it now would be worse than a partial application. But
         an unreported miss is the silent half-state this mechanism exists to
         abolish, so it is returned to the caller (and surfaced by mode:set)
         rather than swallowed. */
      out.push({ mode: def.id, status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * `set_by` stamped on a row the RECONCILE created, so a backfilled row is
 * distinguishable from one the agent (or a human) authored. WI-37842 wants a
 * real provenance column for the harder question (which rows may be RETIRED by
 * implication); this narrower marker is enough for the question a reader of the
 * population actually asks — "did the agent do this, or did the system?" — and
 * needs no migration. Grading depends on the distinction: goal-mode-e2e's
 * `mode-and-subject-integrity` reads these rows, and a backfilled row credited
 * to the agent would be evidence of compliance the agent never performed.
 */
export const RECONCILE_SET_BY = 'mode-implies-reconcile';

/**
 * ── THE RECONCILE (WI-37856) ────────────────────────────────────────────────
 *
 * The cascade above fires on the WRITE that enters a mode. Nothing revisits a
 * row written EARLIER — so an agent that entered a mode before that mode
 * declared an implication keeps a mode set the contract says is impossible,
 * with nothing failing loudly.
 *
 * MEASURED, not hypothesised (2026-08-10): `goal.implies` gained `auto`+`ideate`
 * at 10:57:46Z. All three agents bound to GOAL before that instant lack
 * `ideate`; one lacks `auto` too, i.e. it held a GOAL binding in ask-first
 * posture — the precise failure the "GOAL implies AUTO" clause exists to
 * prevent. Two of the three had hand-written `auto` themselves after reading the
 * contract text, which is the tell: the CONTRACT reached the agent while the
 * MECHANISM did not exist.
 *
 * WHY THIS IS NOT A ONE-OFF BACKFILL SCRIPT. `implies` is a registry field
 * designed to be edited. Every future edit re-opens the identical gap for every
 * agent already holding that mode, so the durable fix is a reconcile that any
 * door can call cheaply and repeatedly — not a migration that fixes today's
 * three rows and leaves the trap armed.
 *
 * IT REUSES THE CASCADE, deliberately. Re-implementing the fill here would mean
 * two places that must agree about "adopt this axis only if it is free", and the
 * one that runs rarely is the one that would silently drift into displacing a
 * posture the owner chose. Reusing `applyImpliedModes` means the never-displace
 * property, the subject-requiring refusal, and the audit row are the SAME code
 * that the write path proves on every call. Consequences worth stating:
 *   - IDEMPOTENT. Every fill is INSERT … ON CONFLICT DO NOTHING, so a second run
 *     writes nothing and reports `already-on`. Safe on a hot path.
 *   - NEVER DISPLACES. A deliberately-chosen `cold-auto` still satisfies
 *     "implies auto" and is left exactly as it is.
 *   - DERIVED rows never inherit `ownerDirected` from the row that implies
 *     them: an owner-directed GOAL does not mean the owner explicitly named
 *     AUTO or IDEATE. If an implied posture needs sticky protection, that is a
 *     separate policy from the provenance bit and must be represented as such.
 *
 * NOT MIRRORED ON EXIT, for the same reason the cascade is not (see above).
 */
export async function reconcileImpliedModes(o: {
  workspaceId: string;
  ownerId: string;
  /** Override the provenance marker; defaults to {@link RECONCILE_SET_BY}. */
  setBy?: string;
  sql?: Sql;
}): Promise<ImpliedModeOutcome[]> {
  const sql = pg(o.sql);
  /* Snapshot first: the loop below inserts, and iterating a live read while
     writing to it is how a reconcile becomes order-dependent. */
  const held = await getModes(o.workspaceId, o.ownerId, sql);
  const out: ImpliedModeOutcome[] = [];
  for (const row of held) {
    if (!resolveImpliedModes(row.mode).length) continue;
    out.push(
      ...(await applyImpliedModes(sql, {
        workspaceId: o.workspaceId,
        ownerId: o.ownerId,
        modeId: row.mode,
        reason: `reconciled: '${row.mode}' was already held when its implications were declared`,
        setBy: o.setBy ?? RECONCILE_SET_BY,
      })),
    );
  }
  return out;
}

/**
 * Apply one mode transition with the axis + sticky semantics. See module doc.
 * All-or-nothing per call; never throws for semantic refusals (returns
 * stickyConflict / error), only for infrastructure failures.
 */
export async function setMode(opts: SetModeOpts): Promise<SetModeResult> {
  const def = modeById(opts.modeId);
  if (!def) return { ok: false, error: `unknown mode '${opts.modeId}'` };
  const sql = pg(opts.sql);
  const axisKey = axisKeyFor(def);
  const isSelf = opts.setBy === opts.ownerId;
  // Only a genuine self-set, or a tool-layer-VERIFIED owner-authority caller,
  // may arm/hold the sticky flag — an ordinary agent peer cannot, no matter
  // what it claims via opts.ownerDirected.
  const ownerAuthorized = isSelf || Boolean(opts.callerIsOwnerAuthority);
  const ownerDirected = Boolean(opts.ownerDirected) && ownerAuthorized;

  const existing = await sql`
    SELECT * FROM harness_shared.agent_modes
    WHERE workspace_id = ${opts.workspaceId} AND owner_id = ${opts.ownerId} AND axis_key = ${axisKey}`;
  const incumbent = existing.length ? toRow(existing[0] as Record<string, unknown>) : null;

  // OWNER-STICKY (D-003): a caller without owner authority cannot change an
  // owner-directed incumbent (neither replace it nor clear it) — regardless
  // of what `ownerDirected` it CLAIMS (an unauthorized peer's claim is never
  // honored — see `ownerAuthorized` above). Self, and a verified
  // owner-authority write (e.g. the admin UI, P-003), pass.
  if (incumbent?.ownerDirected && !ownerAuthorized) {
    return { ok: false, stickyConflict: true, mode: def, switchedFrom: incumbent.mode };
  }

  if (!opts.enabled) {
    if (!incumbent || incumbent.mode !== def.id) return { ok: true, noop: true, mode: def };
    await sql`
      DELETE FROM harness_shared.agent_modes
      WHERE workspace_id = ${opts.workspaceId} AND owner_id = ${opts.ownerId} AND axis_key = ${axisKey}`;
    await audit(sql, {
      workspaceId: opts.workspaceId, ownerId: opts.ownerId, axisKey,
      oldMode: incumbent.mode, newMode: null, reason: opts.reason, setBy: opts.setBy, ownerDirected,
    });
    // WI-6974: a mode CLEAR changes what this agent was told, so push the Orders
    // panel for this owner. Reached only past the `noop` guard above, so the push
    // tracks real transitions — the thing a row trigger on agent_modes could not do.
    await notifyAgentOrdersChanged(opts.ownerId);
    return { ok: true, mode: def, switchedFrom: null };
  }

  // `subject` is tri-state (see SetModeOpts): undefined preserves whatever the
  // incumbent had, so a reason-only refresh cannot silently erase which goal a
  // session is running. On an auto-switch to a DIFFERENT mode there is no
  // subject to preserve — the incumbent's belonged to the mode being displaced.
  const nextSubject =
    opts.subject !== undefined
      ? opts.subject
      : incumbent?.mode === def.id
        ? incumbent.subject
        : null;

  if (incumbent?.mode === def.id) {
    // Already in this mode — refresh reason/sticky/subject only if they changed.
    // subject MUST be part of this comparison: without it, re-asserting GOAL
    // mode with a new goal id would short-circuit as a noop and leave every
    // subsequent work-item stamped with the PREVIOUS goal — a silently wrong
    // stamp, which is worse than no stamp at all.
    if (
      incumbent.ownerDirected === ownerDirected &&
      incumbent.reason === opts.reason &&
      incumbent.subject === nextSubject
    ) {
      /* D-003: a NOOP re-entry still cascades, and that is the point — this is
         how a missing implied row gets REPAIRED. An agent whose auto row was
         cleared by a peer (or a wipe) re-asserts GOAL and gets the posture back;
         if the cascade were gated on "something changed", the one call an agent
         would naturally make to fix it would be the one call that does nothing. */
      const implied = await applyImpliedModes(sql, {
        workspaceId: opts.workspaceId, ownerId: opts.ownerId, modeId: def.id,
        reason: opts.reason, setBy: opts.setBy,
      });
      if (implied.some((i) => i.status === 'set')) await notifyAgentOrdersChanged(opts.ownerId);
      return { ok: true, noop: true, mode: def, ...(implied.length ? { implied } : {}) };
    }
  }

  await sql`
    INSERT INTO harness_shared.agent_modes
      (workspace_id, owner_id, axis_key, mode, reason, set_by, owner_directed, set_at, subject)
    VALUES (${opts.workspaceId}, ${opts.ownerId}, ${axisKey}, ${def.id}, ${opts.reason},
            ${opts.setBy}, ${ownerDirected}, now(), ${nextSubject})
    ON CONFLICT (workspace_id, owner_id, axis_key) DO UPDATE SET
      mode = EXCLUDED.mode, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by,
      owner_directed = EXCLUDED.owner_directed, set_at = EXCLUDED.set_at,
      subject = EXCLUDED.subject`;
  await audit(sql, {
    workspaceId: opts.workspaceId, ownerId: opts.ownerId, axisKey,
    oldMode: incumbent?.mode ?? null, newMode: def.id, reason: opts.reason, setBy: opts.setBy, ownerDirected,
  });
  // D-003: applied BEFORE the orders notify below, so the single push carries the
  // whole posture — the primary mode and everything it implied — rather than the
  // UI briefly rendering an agent in GOAL with an empty autonomy axis.
  const implied = await applyImpliedModes(sql, {
    workspaceId: opts.workspaceId, ownerId: opts.ownerId, modeId: def.id,
    reason: opts.reason, setBy: opts.setBy,
  });
  // WI-6974: same as the clear branch — a set / auto-switch / reason-refresh is a
  // real orders change for THIS owner. Both `noop` early-returns above are already
  // past, so this never fires on a re-assert that wrote nothing.
  await notifyAgentOrdersChanged(opts.ownerId);
  const switchedFrom = incumbent && incumbent.mode !== def.id ? incumbent.mode : null;
  return { ok: true, mode: def, switchedFrom, ...(implied.length ? { implied } : {}) };
}
