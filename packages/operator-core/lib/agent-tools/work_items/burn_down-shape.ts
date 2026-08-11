/**
 * Payload-tier projection for work_items:burn_down.
 *
 * The burn-down handler deliberately computes its aggregates over the whole
 * fetched census. Returning every itemized row, however, lets the generic
 * payload projector cut an array in the middle of a row and append a string
 * marker to a typed row array. That is not merely a shortened answer: it no
 * longer conforms to the tool's declared result schema. This shaper keeps the
 * aggregate facts and projects complete, schema-shaped rows before the generic
 * hard ceiling has a chance to run.
 */

type JsonObject = Record<string, unknown>;
export type BurnDownPayloadTier = 'trimmed' | 'standard';

export interface BurnDownShapeArgs {
  limit?: unknown;
  ids?: unknown;
}

const TIER_CAPS = {
  trimmed: {
    rowsPerBucket: 10,
    deltaRows: 8,
    cohortRows: 20,
    title: 96,
    reason: 180,
    note: 420,
  },
  standard: {
    rowsPerBucket: 20,
    deltaRows: 15,
    cohortRows: 40,
    title: 140,
    reason: 300,
    note: 600,
  },
} as const;

const PARKED_MECHANISMS = new Set([
  'claimHold',
  'blocked',
  'needs-human',
  'external-blocker',
  'state',
]);

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clip(value: unknown, max: number): string {
  const text = requiredString(value);
  if (text.length <= max) return text;
  const marker = `…[TRUNCATED +${text.length - max} chars — re-read with payloadTier:'full']`;
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

function projectRow(value: unknown, titleCap: number): JsonObject | null {
  const row = object(value);
  if (!row || typeof row.id !== 'string' || typeof row.kind !== 'string') return null;
  return {
    id: row.id,
    kind: requiredString(row.kind),
    family: requiredString(row.family),
    harness: stringOrNull(row.harness),
    title: clip(row.title, titleCap),
    state: requiredString(row.state),
    assignee: stringOrNull(row.assignee),
    ...(typeof row.assigneeLive === 'boolean' ? { assigneeLive: row.assigneeLive } : {}),
    takenAt: stringOrNull(row.takenAt),
    lastProgressAt: stringOrNull(row.lastProgressAt),
    updatedAt: requiredString(row.updatedAt),
    severity: stringOrNull(row.severity),
    priority: numberOrNull(row.priority),
  };
}

function projectRows(value: unknown, cap: number, titleCap: number): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => projectRow(row, titleCap))
    .filter((row): row is JsonObject => row !== null)
    .slice(0, cap);
}

function projectParkedRow(value: unknown, titleCap: number, reasonCap: number): JsonObject | null {
  const row = projectRow(value, titleCap);
  const source = object(value);
  if (!row || !source || typeof source.reason !== 'string' || !PARKED_MECHANISMS.has(String(source.mechanism))) {
    return null;
  }
  return {
    ...row,
    reason: clip(source.reason, reasonCap),
    mechanism: source.mechanism,
    ...(typeof source.aliasedState === 'string' ? { aliasedState: source.aliasedState } : {}),
  };
}

function projectParkedRows(value: unknown, cap: number, titleCap: number, reasonCap: number): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => projectParkedRow(row, titleCap, reasonCap))
    .filter((row): row is JsonObject => row !== null)
    .slice(0, cap);
}

function projectDeltaRow(value: unknown, titleCap: number): JsonObject | null {
  const row = object(value);
  if (!row || typeof row.id !== 'string' || typeof row.kind !== 'string') return null;
  return {
    id: row.id,
    kind: row.kind,
    title: clip(row.title, titleCap),
    state: requiredString(row.state),
    harness: stringOrNull(row.harness),
    ts: requiredString(row.ts),
  };
}

function projectDelta(value: unknown, rowCap: number, titleCap: number): JsonObject | undefined {
  const source = object(value);
  if (!source) return undefined;
  const rawRows = Array.isArray(source.rows) ? source.rows : [];
  const rows = rawRows
    .map((row) => projectDeltaRow(row, titleCap))
    .filter((row): row is JsonObject => row !== null)
    .slice(0, rowCap);
  const total = numberOrZero(source.total) || rawRows.length;
  return {
    rows,
    total,
    truncated: source.truncated === true || rawRows.length > rowCap || total > rows.length,
  };
}

function projectTerminal(value: unknown, noteCap: number): JsonObject {
  const source = object(value) ?? {};
  const terminal: JsonObject = {
    total: numberOrZero(source.total),
    done: numberOrZero(source.done),
    passed: numberOrZero(source.passed),
    resolved: numberOrZero(source.resolved),
    closed: numberOrZero(source.closed),
    deprecated: numberOrZero(source.deprecated),
    dropped: numberOrZero(source.dropped),
    deltaSince: stringOrNull(source.deltaSince),
    delta: numberOrZero(source.delta),
    deltaClosedUndated: numberOrZero(source.deltaClosedUndated),
    truncatedByLimit: source.truncatedByLimit === true,
    censusLimit: numberOrZero(source.censusLimit),
  };

  const deltaBy = object(source.deltaBy);
  if (deltaBy) {
    const basis = object(deltaBy.basis) ?? {};
    terminal.deltaBy = {
      fleet: numberOrNull(deltaBy.fleet),
      otherAgents: numberOrZero(deltaBy.otherAgents),
      system: numberOrZero(deltaBy.system),
      unattributed: numberOrZero(deltaBy.unattributed),
      basis: {
        fleet: stringOrNull(basis.fleet),
        fleetSource:
          basis.fleetSource === 'arg' || basis.fleetSource === 'caller-membership'
            ? basis.fleetSource
            : null,
        membership: basis.membership === 'ever-members' ? 'ever-members' : null,
        memberCount: numberOrNull(basis.memberCount),
        note: clip(basis.note, noteCap),
      },
    };
  }
  if (typeof source.deltaByPartitions === 'boolean') {
    terminal.deltaByPartitions = source.deltaByPartitions;
  }

  const authority = object(source.authority) ?? {};
  terminal.authority = {
    counted: numberOrZero(authority.counted),
    committed: numberOrZero(authority.committed),
    validated: numberOrZero(authority.validated),
    proposed: numberOrZero(authority.proposed),
    pendingHuman: numberOrZero(authority.pendingHuman),
    invalid: numberOrZero(authority.invalid),
    legacy: numberOrZero(authority.legacy),
  };
  return terminal;
}

function projectCohortAudit(value: unknown, cap: number, titleCap: number, reasonCap: number): JsonObject | undefined {
  const source = object(value);
  if (!source) return undefined;
  const rawRows = Array.isArray(source.rows) ? source.rows : [];
  const rows = rawRows
    .map((value) => {
      const row = object(value);
      if (!row || typeof row.id !== 'string') return null;
      const bucket = ['terminal', 'parked', 'in-flight', 'unclaimed', 'missing'].includes(String(row.bucket))
        ? row.bucket
        : 'missing';
      const evidence = ['verified', 'incomplete', 'missing', 'not-applicable'].includes(String(row.evidenceVerdict))
        ? row.evidenceVerdict
        : 'not-applicable';
      return {
        id: row.id,
        title: stringOrNull(row.title) == null ? null : clip(row.title, titleCap),
        state: stringOrNull(row.state),
        bucket,
        closureKind: stringOrNull(row.closureKind),
        evidenceVerdict: evidence,
        completionRef: stringOrNull(row.completionRef),
        terminalOwner: stringOrNull(row.terminalOwner),
        reopenRecommended: row.reopenRecommended === true,
        recommendation: stringOrNull(row.recommendation) == null ? null : clip(row.recommendation, reasonCap),
      };
    })
    .filter((row): row is JsonObject => row !== null)
    .slice(0, cap);
  return {
    requested: numberOrZero(source.requested),
    found: numberOrZero(source.found),
    missing: numberOrZero(source.missing),
    reopenRecommended: numberOrZero(source.reopenRecommended),
    rows,
    truncated: source.truncated === true || rawRows.length > cap,
  };
}

function projectFence(value: unknown, noteCap: number): JsonObject | undefined {
  const source = object(value);
  if (!source || source.lane !== 'p2p-lane') return undefined;
  return {
    lane: 'p2p-lane',
    candidates: numberOrZero(source.candidates),
    counted: numberOrZero(source.counted),
    excluded: numberOrZero(source.excluded),
    note: clip(source.note, noteCap),
  };
}

export function shapeBurnDown(
  data: unknown,
  tier: BurnDownPayloadTier,
  args: BurnDownShapeArgs = {},
): unknown {
  const source = object(data);
  if (!source) return data;
  const caps = TIER_CAPS[tier];
  const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : caps.rowsPerBucket;
  const rowCap = Math.max(0, Math.min(caps.rowsPerBucket, Math.floor(requestedLimit)));
  const rawInFlight = Array.isArray(source.inFlight) ? source.inFlight : [];
  const rawParked = Array.isArray(source.parked) ? source.parked : [];
  const rawUnclaimed = Array.isArray(source.unclaimed) ? source.unclaimed : [];
  const counts = object(source.counts) ?? {};
  const totalFor = (key: string, raw: unknown[]) => numberOrZero(counts[key]) || raw.length;
  const inFlight = projectRows(rawInFlight, rowCap, caps.title);
  const parked = projectParkedRows(rawParked, rowCap, caps.title, caps.reason);
  const unclaimed = projectRows(rawUnclaimed, rowCap, caps.title);
  const out: JsonObject = {
    ok: source.ok === true,
    harness: requiredString(source.harness),
    generatedAt: requiredString(source.generatedAt),
    terminal: projectTerminal(source.terminal, caps.note),
    inFlight,
    parked,
    unclaimed,
    counts: {
      total: numberOrZero(counts.total),
      terminal: numberOrZero(counts.terminal),
      inFlight: numberOrZero(counts.inFlight),
      parked: numberOrZero(counts.parked),
      unclaimed: numberOrZero(counts.unclaimed),
    },
    presentation: {
      tier,
      rowCap,
      note: `Itemized rows are capped at ${rowCap} per bucket for the ${tier} payload tier; aggregate counts remain complete. Re-read with payloadTier:'full' for every row.`,
      rows: {
        inFlight: { shown: inFlight.length, total: totalFor('inFlight', rawInFlight), truncated: totalFor('inFlight', rawInFlight) > inFlight.length },
        parked: { shown: parked.length, total: totalFor('parked', rawParked), truncated: totalFor('parked', rawParked) > parked.length },
        unclaimed: { shown: unclaimed.length, total: totalFor('unclaimed', rawUnclaimed), truncated: totalFor('unclaimed', rawUnclaimed) > unclaimed.length },
      },
    },
  };

  const closedSince = projectDelta(source.closedSince, caps.deltaRows, caps.title);
  if (closedSince) out.closedSince = closedSince;
  const openedSince = projectDelta(source.openedSince, caps.deltaRows, caps.title);
  if (openedSince) out.openedSince = openedSince;
  const fence = projectFence(source.fence, caps.note);
  if (fence) out.fence = fence;
  const cohortAudit = projectCohortAudit(source.cohortAudit, caps.cohortRows, caps.title, caps.reason);
  if (cohortAudit) out.cohortAudit = cohortAudit;
  return out;
}
