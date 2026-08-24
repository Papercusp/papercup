/**
 * external-prerequisite-ports.ts — typed-external-prerequisite-attestations-for-release-gates-2026-08-15 P-005.
 *
 * The concrete side effects behind P-003's {@link ProbeRunnerPorts}, plus the READ
 * the release gate actually consumes. This is the wiring item: the runner stays pure
 * logic over injected ports, and everything that touches Postgres, the event bus or
 * an agent's inbox lives here.
 *
 * ## Read D-001 and D-003 before extending this
 *
 * D-001: `release:preflight` DOES NOT EXIST — there is no preflight contract to
 * extend, and its absence is explicitly NOT licence to invent an orchestration plane.
 * So this module has no scheduler, no queue, and no storage of its own. Every export
 * is a thin function an existing surface calls: resolve a handle, map a row, call the
 * surface that already exists. If something here starts wanting to schedule work, that
 * is the forbidden shape rather than a missing feature.
 *
 * D-003: P-003 declared a sixth port, `refreshScorecardCriterion` ("the scorecards
 * emit surface"). P-005 REMOVED it instead of wiring it, for two independent reasons.
 * It was unbuildable: `ExternalPrerequisiteSpec` carries no rubric or criterion
 * binding, and `emitScorecard` is a whole-card write whose
 * `validateScorecardCompleteness` requires a rating for every criterion of the rubric,
 * so no per-criterion refresh exists to call. And it was the wrong SHAPE: a criterion
 * re-stated on every probe run is a hand-maintained second copy of a truth this store
 * already owns. {@link readScopePrerequisiteReadiness} below is the replacement — the
 * gate PULLS a derived verdict, which cannot go stale, instead of being pushed one
 * that can drift.
 *
 * ## Fail CLOSED, and never synthesise a receipt (D-002)
 *
 * `present: false` is a POSITIVE, durable claim — *the probe ran and the wall is
 * down*. An operator reads it, and later "it came back" transitions are computed
 * against it. So no adapter here manufactures a row on an error path: a failing read
 * reports the failure and the readiness resolver treats the missing/uninterpretable
 * receipt as `absent`, which is already not-satisfied. The gate fails closed without
 * the store being taught something untrue.
 */
import {
  attestationToRow,
  isPrerequisiteSatisfied,
  resolvePrerequisiteReadiness,
  rowToAttestation,
  type ExternalPrerequisiteAttestation,
  type ExternalPrerequisiteAttestationRow,
  type ExternalPrerequisiteSpec,
  type PrerequisiteReadiness,
} from './external-prerequisites';
import type { ProbeRunnerPorts } from './external-prerequisite-probe-runner';
// Type-only: erased at compile time, so naming the identity shape here does NOT pull
// the coordination graph into this module's runtime imports (the reason every heavy
// dependency below is resolved with a dynamic import instead).
import type { AgentIdentity } from '../agent-tools/coordination/identity';

/** Default emitter/sender attribution when a caller names none. */
export const EXTERNAL_PREREQUISITE_SOURCE = 'external-prerequisite-probe';

/**
 * Which release scope a set of prerequisites belongs to. `workspaceId` is optional
 * because the ambient workspace is the right default for an interactive call; a
 * BACKGROUND caller should pass it explicitly (the EI-15486 class: an ambient
 * derivation resolved several awaits deep can silently fall through to the wrong
 * workspace, and a scoped write then matches zero rows).
 */
export interface PrerequisiteScope {
  readonly harnessSlug: string;
  readonly workspaceId?: string;
  /** Attribution stamped on emitted events and the lane-owner message. */
  readonly source?: string;
}

/**
 * Injectable seams. Production uses the real surfaces; tests substitute these so the
 * mapping and lifecycle rules are exercised without Postgres, an event bus or an
 * inbox. The seams are the LEAF effects only — deliberately not a general-purpose
 * indirection layer.
 */
export interface ProbeRunnerPortDeps {
  loadRow?: (scope: ResolvedScope, key: string) => Promise<ExternalPrerequisiteAttestationRow | null>;
  loadRows?: (scope: ResolvedScope, keys: readonly string[]) => Promise<ExternalPrerequisiteAttestationRow[]>;
  saveRow?: (scope: ResolvedScope, row: ExternalPrerequisiteAttestationRow) => Promise<void>;
  emit?: (opts: {
    key: string;
    summary: string;
    payload: unknown;
    source: string;
    workspaceId?: string;
  }) => Promise<void>;
  /** Resolve the ownerId currently accountable for a work-item, or null when unheld. */
  resolveLaneOwner?: (workItem: string, scope: ResolvedScope) => Promise<string | null>;
  notifyOwner?: (input: {
    ownerId: string;
    summary: string;
    workItem: string;
    scope: ResolvedScope;
  }) => Promise<void>;
}

/** A {@link PrerequisiteScope} with its defaults applied. */
export interface ResolvedScope {
  readonly workspaceId: string | undefined;
  readonly harnessSlug: string;
  readonly source: string;
}

function resolveScope(scope: PrerequisiteScope): ResolvedScope {
  return {
    workspaceId: scope.workspaceId,
    harnessSlug: scope.harnessSlug,
    source: scope.source ?? EXTERNAL_PREREQUISITE_SOURCE,
  };
}

/**
 * Select the stored columns as an {@link ExternalPrerequisiteAttestationRow}.
 *
 * The two instants are rendered as explicit ISO-8601 UTC rather than `::text`.
 * `rowToAttestation` parses them with `Date.parse`, and a bare `::text` render of a
 * timestamptz is Postgres' own display format in the session's timezone — which
 * `Date.parse` handles by implementation-defined behaviour, and which would silently
 * carry a non-UTC offset. The contract on both fields says "ISO-8601 UTC instant", so
 * the query produces exactly that.
 */
const ROW_COLUMNS = `
  prerequisite_key,
  capability_kind,
  present,
  binding,
  to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
  to_char(expires_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
  provenance,
  probe_ref
`;

async function orgSql() {
  // Imported lazily: this module sits in the release tree and is reached from gate
  // surfaces, and a static import of the org pool here would pull the database (and,
  // for the coordination seams below, the whole agent-tools graph) into any importer
  // of the runner. The sibling checkpoint modules resolve db-org the same way.
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql;
}

async function resolveWorkspaceId(scope: ResolvedScope): Promise<string> {
  if (scope.workspaceId) return scope.workspaceId;
  const { activeWorkspaceId } = await import('../workspace-registry');
  return activeWorkspaceId();
}

async function defaultLoadRow(
  scope: ResolvedScope,
  key: string,
): Promise<ExternalPrerequisiteAttestationRow | null> {
  const sql = await orgSql();
  const ws = await resolveWorkspaceId(scope);
  const rows = await sql<ExternalPrerequisiteAttestationRow[]>`
    SELECT ${sql.unsafe(ROW_COLUMNS)}
      FROM harness_shared.external_prerequisite_attestations
     WHERE workspace_id = ${ws}
       AND harness_slug = ${scope.harnessSlug}
       AND prerequisite_key = ${key}
  `;
  return rows[0] ?? null;
}

async function defaultLoadRows(
  scope: ResolvedScope,
  keys: readonly string[],
): Promise<ExternalPrerequisiteAttestationRow[]> {
  if (keys.length === 0) return [];
  const sql = await orgSql();
  const ws = await resolveWorkspaceId(scope);
  // Uses external_prerequisite_attestations_scope_expiry_key — the index P-002 built
  // for exactly this read ("which prerequisites in this scope are still standing?").
  return await sql<ExternalPrerequisiteAttestationRow[]>`
    SELECT ${sql.unsafe(ROW_COLUMNS)}
      FROM harness_shared.external_prerequisite_attestations
     WHERE workspace_id = ${ws}
       AND harness_slug = ${scope.harnessSlug}
       AND prerequisite_key = ANY(${[...keys]}::text[])
  `;
}

async function defaultSaveRow(scope: ResolvedScope, row: ExternalPrerequisiteAttestationRow): Promise<void> {
  const sql = await orgSql();
  const ws = await resolveWorkspaceId(scope);
  await sql`
    INSERT INTO harness_shared.external_prerequisite_attestations
      (workspace_id, harness_slug, prerequisite_key, capability_kind, present,
       binding, observed_at, expires_at, provenance, probe_ref)
    VALUES (
      ${ws}, ${scope.harnessSlug}, ${row.prerequisite_key}, ${row.capability_kind}, ${row.present},
      ${JSON.stringify(row.binding)}::jsonb, ${row.observed_at}::timestamptz,
      ${row.expires_at}::timestamptz, ${row.provenance}, ${row.probe_ref}
    )
    ON CONFLICT (workspace_id, harness_slug, prerequisite_key) DO UPDATE
      SET capability_kind = EXCLUDED.capability_kind,
          present         = EXCLUDED.present,
          binding         = EXCLUDED.binding,
          observed_at     = EXCLUDED.observed_at,
          expires_at      = EXCLUDED.expires_at,
          provenance      = EXCLUDED.provenance,
          probe_ref       = EXCLUDED.probe_ref,
          updated_at      = now()
  `;
}

async function defaultEmit(opts: {
  key: string;
  summary: string;
  payload: unknown;
  source: string;
  workspaceId?: string;
}): Promise<void> {
  const { emitAwaitedEvent } = await import('../events/await/engine');
  await emitAwaitedEvent({
    key: opts.key,
    summary: opts.summary,
    payload: opts.payload,
    source: opts.source,
    workspaceId: opts.workspaceId,
  });
}

async function defaultResolveLaneOwner(workItem: string): Promise<string | null> {
  const { getIssue } = await import('../issues-engineer');
  const issue = await getIssue(workItem);
  return issue?.assignee ?? null;
}

async function defaultNotifyOwner(input: {
  ownerId: string;
  summary: string;
  workItem: string;
  scope: ResolvedScope;
}): Promise<void> {
  const [{ sendMessage }, { wakeRecipients }] = await Promise.all([
    import('../agent-tools/coordination/messages'),
    import('../agent-tools/coordination/inbox-wake'),
  ]);
  const workspaceId = await resolveWorkspaceId(input.scope);
  // The same two steps coord:send { wake } performs: the durable inbox row is the
  // truth, the wake is the notification. A synthetic system identity, matching how
  // the await engine attributes its own emits.
  const identity: AgentIdentity = {
    ownerId: input.scope.source,
    ownerLabel: input.scope.source,
    source: 'static-client',
    workspaceId,
    userId: null,
  };
  await sendMessage(
    identity,
    {
      to: [input.ownerId],
      summary: input.summary,
      body: `${input.summary}\n\nAccountable work-item: ${input.workItem}`,
      harnessSlug: input.scope.harnessSlug,
    },
  );
  await wakeRecipients([input.ownerId], {
    summary: input.summary,
    source: input.scope.source,
    workspaceId,
  });
}

/**
 * Build the concrete ports the probe runner drives.
 *
 * Every adapter is deliberately thin and lets its errors PROPAGATE. The runner wraps
 * each port call and records a failure as a `problem` string on the run result rather
 * than aborting, so propagating is what makes a port failure visible; swallowing here
 * would report a clean run that did not happen.
 */
export function createProbeRunnerPorts(
  scope: PrerequisiteScope,
  deps: ProbeRunnerPortDeps = {},
): ProbeRunnerPorts {
  const resolved = resolveScope(scope);
  return {
    async loadAttestation(key: string): Promise<ExternalPrerequisiteAttestation | null> {
      const row = await (deps.loadRow ?? defaultLoadRow)(resolved, key);
      // rowToAttestation returns null — never a partial — for an uninterpretable row,
      // so a malformed receipt reads as `absent` downstream instead of as a receipt
      // with missing fields.
      return rowToAttestation(row);
    },

    async saveAttestation(attestation: ExternalPrerequisiteAttestation): Promise<void> {
      await (deps.saveRow ?? defaultSaveRow)(resolved, attestationToRow(attestation));
    },

    async emitEvent(event): Promise<void> {
      await (deps.emit ?? defaultEmit)({
        key: event.key,
        summary: event.summary,
        payload: event.payload,
        source: resolved.source,
        workspaceId: resolved.workspaceId,
      });
    },

    async wakeLaneOwner(wake): Promise<void> {
      const resolveOwner = deps.resolveLaneOwner ?? ((id: string) => defaultResolveLaneOwner(id));
      const ownerId = await resolveOwner(wake.owningWorkItem, resolved);
      if (!ownerId) {
        // An unheld lane is a real, actionable condition — an external wall moved and
        // nobody is accountable for it — so it is surfaced rather than silently
        // skipped. Throwing is the only channel available: the runner records it as a
        // `problem` on the run result. It is deliberately NOT widened to a broadcast.
        throw new Error(
          `no holder to wake for '${wake.owningWorkItem}' — the lane accountable for this prerequisite is unassigned`,
        );
      }
      await (deps.notifyOwner ?? defaultNotifyOwner)({
        ownerId,
        summary: wake.summary,
        workItem: wake.owningWorkItem,
        scope: resolved,
      });
    },
  };
}

/** One prerequisite's derived verdict, as of a single evaluation instant. */
export interface PrerequisiteReadinessSnapshot {
  readonly key: string;
  readonly readiness: PrerequisiteReadiness;
  readonly satisfied: boolean;
}

/**
 * The gate's READ (D-003): resolve every declared prerequisite's readiness right now,
 * derived from the stored receipts.
 *
 * This is what replaced the removed `refreshScorecardCriterion` push. Because the
 * verdict is COMPUTED at evaluation time rather than read back from something an
 * earlier run wrote, it cannot go stale — a receipt that lapsed one second ago
 * resolves as `expired` on the very next read, with nothing having to write a row to
 * make that true.
 *
 * Every spec is evaluated against ONE instant, as `resolvePrerequisiteReadiness`
 * requires: a long scope-walk that re-read the clock per prerequisite could report two
 * of them as of different times, and a boundary case would land on whichever side the
 * walk happened to reach it.
 *
 * A spec with no stored row resolves as `absent`, which is already not-satisfied — so
 * an unprobed prerequisite fails the gate closed rather than being skipped.
 */
export async function readScopePrerequisiteReadiness(
  scope: PrerequisiteScope,
  specs: readonly ExternalPrerequisiteSpec[],
  opts: { nowMs?: number; deps?: Pick<ProbeRunnerPortDeps, 'loadRows'> } = {},
): Promise<PrerequisiteReadinessSnapshot[]> {
  const resolved = resolveScope(scope);
  const nowMs = opts.nowMs ?? Date.now();
  const keys = specs.map((s) => s.key);
  const rows = await (opts.deps?.loadRows ?? defaultLoadRows)(resolved, keys);

  const byKey = new Map<string, ExternalPrerequisiteAttestationRow>();
  for (const row of rows) byKey.set(row.prerequisite_key, row);

  return specs.map((spec) => {
    const readiness = resolvePrerequisiteReadiness(rowToAttestation(byKey.get(spec.key) ?? null), nowMs);
    return { key: spec.key, readiness, satisfied: isPrerequisiteSatisfied(readiness) };
  });
}

/**
 * The admitting predicate for a whole scope. An EMPTY snapshot list is `true` — a
 * release scope that declares no external prerequisites has no external wall to be
 * blocked on, which is different from one whose prerequisites are unprobed (those
 * resolve as `absent` and fail).
 */
export function allPrerequisitesSatisfied(snapshots: readonly PrerequisiteReadinessSnapshot[]): boolean {
  return snapshots.every((s) => s.satisfied);
}

/** The unsatisfied subset, for a gate that must say WHICH wall is down. */
export function unsatisfiedPrerequisites(
  snapshots: readonly PrerequisiteReadinessSnapshot[],
): PrerequisiteReadinessSnapshot[] {
  return snapshots.filter((s) => !s.satisfied);
}
