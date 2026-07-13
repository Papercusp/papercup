export type ExternalBlockerKind = 'event' | 'gate' | 'runtime' | 'human';

export interface ExternalBlockerRecord {
  kind: ExternalBlockerKind;
  ref: string;
  summary: string;
  status: 'active' | 'cleared';
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  evidence?: string;
  nextVerb?: string;
  clearedAt?: string;
  clearedBy?: string;
}

/** Parse defensively because payload is federated/untrusted JSON. */
export function readExternalBlockers(payload: unknown): ExternalBlockerRecord[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const rows = (payload as Record<string, unknown>).externalBlockers;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is ExternalBlockerRecord => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const r = row as Record<string, unknown>;
    return (
      ['event', 'gate', 'runtime', 'human'].includes(String(r.kind)) &&
      typeof r.ref === 'string' &&
      typeof r.summary === 'string' &&
      (r.status === 'active' || r.status === 'cleared') &&
      typeof r.createdAt === 'string' &&
      typeof r.createdBy === 'string' &&
      typeof r.updatedAt === 'string'
    );
  });
}

export function activeExternalBlockers(payload: unknown): ExternalBlockerRecord[] {
  return readExternalBlockers(payload).filter((blocker) => blocker.status === 'active');
}

/** Pure history-preserving upsert. Clearing marks the record; it never deletes it,
 * and it never touches internal work-item dependency edges. */
export function updateExternalBlockerHistory(
  payload: unknown,
  input: {
    kind: ExternalBlockerKind;
    ref: string;
    summary?: string;
    evidence?: string;
    nextVerb?: string;
    clear?: boolean;
  },
  actor: string,
  now = new Date().toISOString(),
): { blockers: ExternalBlockerRecord[]; changed: boolean } {
  const blockers = readExternalBlockers(payload);
  const index = [...blockers]
    .map((row, i) => ({ row, i }))
    .reverse()
    .find(({ row }) => row.kind === input.kind && row.ref === input.ref && row.status === 'active')?.i;

  if (input.clear) {
    if (index === undefined) return { blockers, changed: false };
    const current = blockers[index]!;
    blockers[index] = {
      ...current,
      status: 'cleared',
      updatedAt: now,
      clearedAt: now,
      clearedBy: actor,
      ...(input.evidence ? { evidence: input.evidence } : {}),
    };
    return { blockers, changed: true };
  }

  if (index !== undefined) {
    const current = blockers[index]!;
    blockers[index] = {
      ...current,
      summary: input.summary?.trim() || current.summary,
      updatedAt: now,
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.nextVerb ? { nextVerb: input.nextVerb } : {}),
    };
    return { blockers, changed: true };
  }

  blockers.push({
    kind: input.kind,
    ref: input.ref,
    summary: input.summary?.trim() || `${input.kind} dependency: ${input.ref}`,
    status: 'active',
    createdAt: now,
    createdBy: actor,
    updatedAt: now,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.nextVerb ? { nextVerb: input.nextVerb } : {}),
  });
  const active = blockers.filter((row) => row.status === 'active');
  const cleared = blockers.filter((row) => row.status === 'cleared').slice(-40);
  return { blockers: [...cleared, ...active], changed: true };
}
